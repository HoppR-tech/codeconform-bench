import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { QUALITY_DIMENSIONS, type AgentOutput, type CampaignAggregate, type CampaignManifest, type CampaignPorts, type CampaignResult, type Condition, type ConditionSummary, type QualityDimensions, type RunRecord } from './contracts.js'
import { hashTree, sha256 } from './digest.js'
import { renderCampaignReport } from './report.js'

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
}

function deterministicRandom(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function bootstrapInterval(values: readonly number[], samples: number, seed: number): [number, number] | null {
  if (values.length === 0) return null
  const random = deterministicRandom(seed)
  const means: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0)
    means.push(mean(resampled) ?? 0)
  }
  means.sort((left, right) => left - right)
  return [
    means[Math.floor((means.length - 1) * 0.025)] ?? 0,
    means[Math.ceil((means.length - 1) * 0.975)] ?? 0,
  ]
}

function functionalOutcome(record: RunRecord): number | null {
  if (record.status === 'infrastructure_error') return null
  return record.status === 'scored' || record.status === 'evaluator_error' ? 1 : 0
}

function qualityOutcome(record: RunRecord): number | null {
  if (record.status === 'evaluator_error' || record.status === 'infrastructure_error') return null
  return record.status === 'scored' ? record.codeQualityScore : 0
}

function qualityPassOutcome(record: RunRecord): number | null {
  if (record.status === 'evaluator_error' || record.status === 'infrastructure_error') return null
  return record.status === 'scored' && record.qualityQualified ? 1 : 0
}

function dimensionMeans(records: readonly RunRecord[]): QualityDimensions | null {
  const valid = records.filter((record) => record.status !== 'evaluator_error' && record.status !== 'infrastructure_error')
  if (valid.length === 0) return null
  return Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
    dimension,
    mean(valid.map((record) => record.status === 'scored' ? (record.qualityDimensions?.[dimension] ?? 0) : 0)) ?? 0,
  ])) as QualityDimensions
}

function conditionSummary(records: readonly RunRecord[], condition: Condition): ConditionSummary {
  const selected = records.filter((record) => record.condition === condition)
  const functionalOutcomes = selected.flatMap((record) => {
    const outcome = functionalOutcome(record)
    return outcome === null ? [] : [outcome]
  })
  const qualityScores = selected.flatMap((record) => {
    const score = qualityOutcome(record)
    return score === null ? [] : [score]
  })
  const qualityPasses = selected.flatMap((record) => {
    const outcome = qualityPassOutcome(record)
    return outcome === null ? [] : [outcome]
  })
  return {
    total: selected.length,
    validFunctionalAttempts: functionalOutcomes.length,
    validQualityAttempts: qualityScores.length,
    functionalPasses: functionalOutcomes.reduce((total, outcome) => total + outcome, 0),
    qualityPasses: qualityPasses.reduce((total, outcome) => total + outcome, 0),
    functionalFailures: selected.filter((record) => record.status === 'functional_failed').length,
    agentErrors: selected.filter((record) => record.status === 'agent_error').length,
    infrastructureErrors: selected.filter((record) => record.status === 'infrastructure_error').length,
    evaluatorErrors: selected.filter((record) => record.status === 'evaluator_error').length,
    functionalPassAt1: mean(functionalOutcomes),
    qualityPassAt1: mean(qualityPasses),
    codeQualityMean: mean(qualityScores),
    dimensionMeans: dimensionMeans(selected),
    promptTokens: selected.reduce((total, record) => total + record.promptTokens, 0),
    completionTokens: selected.reduce((total, record) => total + record.completionTokens, 0),
    durationMeanMs: mean(selected.map((record) => record.durationMs)),
    cost: selected.every((record) => record.cost === null) ? null : selected.reduce((total, record) => total + (record.cost ?? 0), 0),
  }
}

export function aggregateRecords(records: readonly RunRecord[], bootstrapSamples: number, seed: number): CampaignAggregate {
  const pairs = new Map<string, Partial<Record<Condition, RunRecord>>>()
  for (const record of records) {
    const pair = pairs.get(record.pairId) ?? {}
    pair[record.condition] = record
    pairs.set(record.pairId, pair)
  }
  const functionalDeltas: number[] = []
  const qualityPassDeltas: number[] = []
  const qualityDeltas: number[] = []
  const tokenEfficiency: number[] = []
  for (const pair of pairs.values()) {
    if (!pair.baseline || !pair.grace) continue
    const baselineFunctional = functionalOutcome(pair.baseline)
    const graceFunctional = functionalOutcome(pair.grace)
    if (baselineFunctional !== null && graceFunctional !== null) functionalDeltas.push(graceFunctional - baselineFunctional)
    const baselineScore = qualityOutcome(pair.baseline)
    const graceScore = qualityOutcome(pair.grace)
    const baselinePass = qualityPassOutcome(pair.baseline)
    const gracePass = qualityPassOutcome(pair.grace)
    if (baselineScore === null || graceScore === null || baselinePass === null || gracePass === null) continue

    const delta = graceScore - baselineScore
    qualityPassDeltas.push(gracePass - baselinePass)
    qualityDeltas.push(delta)
    const baselineTokens = pair.baseline.promptTokens + pair.baseline.completionTokens
    const graceTokens = pair.grace.promptTokens + pair.grace.completionTokens
    if (graceTokens > baselineTokens) tokenEfficiency.push(delta * 1_000 / (graceTokens - baselineTokens))
  }

  return {
    baseline: conditionSummary(records, 'baseline'),
    grace: conditionSummary(records, 'grace'),
    functionalPairedAttempts: functionalDeltas.length,
    qualityPairedAttempts: qualityDeltas.length,
    graceFunctionalPassAt1Delta: mean(functionalDeltas),
    graceQualityPassAt1Delta: mean(qualityPassDeltas),
    graceCodeQualityDeltaMean: mean(qualityDeltas),
    graceCodeQualityBootstrap95: bootstrapInterval(qualityDeltas, bootstrapSamples, seed),
    qualityGainPerAdditional1000TokensMean: mean(tokenEfficiency),
    bootstrapSamples,
    seed,
  }
}


export async function runCampaign(manifest: CampaignManifest, ports: CampaignPorts): Promise<CampaignResult> {
  await ports.verifyTarget()
  const target = await realpath(manifest.target.checkout)
  const output = resolve(manifest.outputDirectory)
  const rel = relative(target, output)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('outputDirectory must be outside the target checkout')

  try {
    await lstat(output)
    throw new Error('outputDirectory must not already exist')
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await mkdir(resolve(output, 'runs'), { recursive: true })
  await mkdir(resolve(output, 'workspaces'), { recursive: true })
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(resolve(output, 'campaign-manifest.json'), manifestJson)
  const manifestDigest = sha256(manifestJson)
  const records: RunRecord[] = []

  for (let index = 1; index <= manifest.repetitions; index += 1) {
    const pairId = `pair-${String(index).padStart(2, '0')}`
    const conditions = index % 2 === 1 ? manifest.order : [...manifest.order].reverse()
    for (const condition of conditions) {
      const workspace = resolve(output, 'workspaces', `${pairId}-${condition}`)
      await ports.prepareWorkspace(workspace)
      const startedAt = Date.now()
      let agent: AgentOutput
      try {
        agent = await ports.runAgent({
          condition,
          pairId,
          workspace,
          task: manifest.task,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'agent failed'
        agent = {
          status: 'infrastructure_error',
          error: message,
          model: manifest.model.id,
          provider: null,
          promptTokens: 0,
          completionTokens: 0,
          cost: null,
          trace: [{ role: 'system', content: `Harness error: ${message}` }],
        }
      }
      const traceJson = `${JSON.stringify(agent.trace, null, 2)}\n`
      const traceDigest = sha256(traceJson)
      await writeFile(resolve(output, 'runs', `${pairId}-${condition}-trace.json`), traceJson)
      const candidateDigest = await hashTree(workspace)

      let status: RunRecord['status'] = agent.status === 'infrastructure_error' ? 'infrastructure_error' : 'agent_error'
      let gateExitCode: number | null = null
      let codeQualityScore: number | null = null
      let qualityQualified: boolean | null = null
      let qualityDimensions: QualityDimensions | null = null
      let violations: number | null = null

      if (agent.status === 'completed') {
        const gate = await ports.runFunctionalGate(workspace)
        gateExitCode = gate.exitCode
        if (gate.exitCode !== 0 || gate.signal || gate.timedOut || await hashTree(workspace) !== candidateDigest) {
          status = 'functional_failed'
        } else {
          const evaluation = await ports.evaluate(workspace, pairId, condition)
          if (evaluation.status === 'evaluator_error' || await hashTree(workspace) !== candidateDigest) {
            status = 'evaluator_error'
          } else {
            status = 'scored'
            codeQualityScore = evaluation.qualityScore ?? null
            qualityQualified = evaluation.qualityQualified ?? null
            qualityDimensions = evaluation.dimensions ?? null
            violations = evaluation.violations ?? null
          }
        }
      }

      const record: RunRecord = {
        pairId,
        condition,
        status,
        agentError: agent.error,
        targetCommit: manifest.target.commit,
        targetTree: manifest.target.tree,
        candidateDigest,
        traceDigest,
        model: agent.model,
        provider: agent.provider,
        promptTokens: agent.promptTokens,
        completionTokens: agent.completionTokens,
        cost: agent.cost,
        functionalGateExitCode: gateExitCode,
        codeQualityScore,
        qualityQualified,
        qualityDimensions,
        violations,
        durationMs: Date.now() - startedAt,
      }
      records.push(record)
      await writeFile(resolve(output, 'runs', `${pairId}-${condition}.json`), `${JSON.stringify({ manifestDigest, ...record }, null, 2)}\n`)
    }
  }

  const aggregate = aggregateRecords(records, manifest.bootstrapSamples, manifest.seed)
  await writeFile(resolve(output, 'aggregate.json'), `${JSON.stringify({ campaignId: manifest.campaignId, manifestDigest, ...aggregate }, null, 2)}\n`)
  await writeFile(resolve(output, 'report.md'), renderCampaignReport(manifest.campaignId, manifestDigest, manifest.grace.mcpUrl, records, aggregate))
  return { records, aggregate }
}
