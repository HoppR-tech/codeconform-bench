import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CampaignAggregate, CampaignManifest, CampaignPorts, CampaignResult, Condition, ConditionSummary, RunRecord } from './contracts.js'
import { hashTree, sha256 } from './digest.js'

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? null)
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
  const medians: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0)
    medians.push(median(resampled) ?? 0)
  }
  medians.sort((left, right) => left - right)
  return [
    medians[Math.floor((medians.length - 1) * 0.025)] ?? 0,
    medians[Math.ceil((medians.length - 1) * 0.975)] ?? 0,
  ]
}

function conditionSummary(records: readonly RunRecord[], condition: Condition): ConditionSummary {
  const selected = records.filter((record) => record.condition === condition)
  const scored = selected.filter((record) => record.status === 'scored')
  const functionalFailures = selected.filter((record) => record.status === 'functional_failed').length
  return {
    total: selected.length,
    scored: scored.length,
    functionalFailures,
    agentErrors: selected.filter((record) => record.status === 'agent_error').length,
    evaluatorErrors: selected.filter((record) => record.status === 'evaluator_error').length,
    functionalFailureRate: selected.length === 0 ? null : functionalFailures / selected.length,
    architectureMedian: median(scored.flatMap((record) => record.architectureScore === null ? [] : [record.architectureScore])),
    weightedArchitectureMedian: median(scored.flatMap((record) => record.weightedArchitectureScore === null ? [] : [record.weightedArchitectureScore])),
    promptTokens: selected.reduce((total, record) => total + record.promptTokens, 0),
    completionTokens: selected.reduce((total, record) => total + record.completionTokens, 0),
    durationMedianMs: median(selected.map((record) => record.durationMs)),
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
  const deltas: number[] = []
  const tokenEfficiency: number[] = []
  for (const pair of pairs.values()) {
    if (pair.baseline?.status !== 'scored' || pair.grace?.status !== 'scored') continue
    if (pair.baseline.weightedArchitectureScore === null || pair.grace.weightedArchitectureScore === null) continue
    const delta = pair.grace.weightedArchitectureScore - pair.baseline.weightedArchitectureScore
    deltas.push(delta)

    const baselineTokens = pair.baseline.promptTokens + pair.baseline.completionTokens
    const graceTokens = pair.grace.promptTokens + pair.grace.completionTokens
    if (graceTokens > baselineTokens) tokenEfficiency.push(delta * 1_000 / (graceTokens - baselineTokens))
  }

  return {
    baseline: conditionSummary(records, 'baseline'),
    grace: conditionSummary(records, 'grace'),
    completeScoredPairs: deltas.length,
    graceDeltaMedian: median(deltas),
    graceDeltaBootstrap95: bootstrapInterval(deltas, bootstrapSamples, seed),
    qualityGainPerAdditional1000TokensMedian: median(tokenEfficiency),
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
  const graceContext = await readFile(manifest.graceContextFile, 'utf8')
  if (sha256(graceContext) !== manifest.graceContextDigest) throw new Error('Grace context does not match manifest digest')
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
      const agent = await ports.runAgent({
        condition,
        pairId,
        workspace,
        task: manifest.task,
        ...(condition === 'grace' ? { graceContext } : {}),
      })
      const traceJson = `${JSON.stringify(agent.trace, null, 2)}\n`
      const traceDigest = sha256(traceJson)
      await writeFile(resolve(output, 'runs', `${pairId}-${condition}-trace.json`), traceJson)
      const candidateDigest = await hashTree(workspace)

      let status: RunRecord['status'] = 'agent_error'
      let gateExitCode: number | null = null
      let architectureScore: number | null = null
      let weightedArchitectureScore: number | null = null
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
            architectureScore = evaluation.score ?? null
            weightedArchitectureScore = evaluation.weightedScore ?? null
            violations = evaluation.violations ?? null
          }
        }
      }

      const record: RunRecord = {
        pairId,
        condition,
        status,
        targetCommit: manifest.target.commit,
        targetTree: manifest.target.tree,
        graceContextDigest: manifest.graceContextDigest,
        candidateDigest,
        traceDigest,
        model: agent.model,
        provider: agent.provider,
        promptTokens: agent.promptTokens,
        completionTokens: agent.completionTokens,
        cost: agent.cost,
        functionalGateExitCode: gateExitCode,
        architectureScore,
        weightedArchitectureScore,
        violations,
        durationMs: Date.now() - startedAt,
      }
      records.push(record)
      await writeFile(resolve(output, 'runs', `${pairId}-${condition}.json`), `${JSON.stringify({ manifestDigest, ...record }, null, 2)}\n`)
    }
  }

  const aggregate = aggregateRecords(records, manifest.bootstrapSamples, manifest.seed)
  await writeFile(resolve(output, 'aggregate.json'), `${JSON.stringify({ campaignId: manifest.campaignId, manifestDigest, graceContextDigest: manifest.graceContextDigest, ...aggregate }, null, 2)}\n`)
  return { records, aggregate }
}
