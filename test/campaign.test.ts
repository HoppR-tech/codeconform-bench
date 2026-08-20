import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { aggregateRecords, runCampaign } from '../src/campaign.js'
import type { CampaignManifest, RunRecord } from '../src/contracts.js'
import { buildQualityEvidence } from './evidence-fixture.js'

const execFileAsync = promisify(execFile)

function outcomeRecord(pairId: string, condition: 'baseline' | 'grace', status: RunRecord['status'], qualityScore = 0): RunRecord {
  const scored = status === 'scored'
  return {
    pairId,
    condition,
    status,
    agentError: status === 'agent_error' || status === 'infrastructure_error' ? status : null,
    targetCommit: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    candidateDigest: 'sha256:' + 'c'.repeat(64),
    traceDigest: 'sha256:' + 'd'.repeat(64),
    model: 'fixture-model',
    provider: 'fixture-provider',
    promptTokens: 100,
    completionTokens: 10,
    cost: 0.01,
    functionalGatePassed: scored || status === 'evaluator_error' ? true : status === 'functional_failed' ? false : null,
    durationMs: 100,
    codeQualityScore: scored ? qualityScore : null,
    qualityQualified: scored ? qualityScore >= 0.7 : null,
    qualityDimensions: scored ? {
      architecture: qualityScore,
      maintainability: qualityScore,
      clarity: qualityScore,
      tests: qualityScore,
      robustness: qualityScore,
    } : null,
    violations: scored ? 0 : null,
    qualityEvidence: scored ? buildQualityEvidence(qualityScore) : null,
  }
}

test('scores candidate failures as zero and excludes infrastructure failures', () => {
  const aggregate = aggregateRecords([
    outcomeRecord('pair-01', 'baseline', 'functional_failed'),
    outcomeRecord('pair-01', 'grace', 'scored', 0.8),
    outcomeRecord('pair-02', 'baseline', 'agent_error'),
    outcomeRecord('pair-02', 'grace', 'infrastructure_error'),
  ], 100, 7)

  assert.equal(aggregate.baseline.codeQualityMean, 0)
  assert.equal(aggregate.baseline.validQualityAttempts, 2)
  assert.equal(aggregate.grace.codeQualityMean, 0.8)
  assert.equal(aggregate.grace.validQualityAttempts, 1)
  assert.equal(aggregate.grace.infrastructureErrors, 1)
  assert.equal(aggregate.functionalPairedAttempts, 1)
  assert.equal(aggregate.qualityPairedAttempts, 1)
  assert.equal(aggregate.graceCodeQualityDeltaMean, 0.8)
})

test('runs paired conditions, gates before scoring, and preserves provenance', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-campaign-'))
  const target = resolve(root, 'target')
  const output = resolve(root, 'results')
  await execFileAsync('git', ['init', target])
  await writeFile(resolve(target, 'source.ts'), 'export const value = 1\n')
  await execFileAsync('git', ['-C', target, 'add', 'source.ts'])
  await execFileAsync('git', ['-C', target, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'])
  const { stdout: commitOutput } = await execFileAsync('git', ['-C', target, 'rev-parse', 'HEAD'])
  const { stdout: treeOutput } = await execFileAsync('git', ['-C', target, 'rev-parse', 'HEAD^{tree}'])

  const manifest: CampaignManifest = {
    schemaVersion: 2,
    campaignId: 'fixture-v2',
    target: { checkout: target, repository: 'fixture', commit: commitOutput.trim(), tree: treeOutput.trim(), digest: 'sha256:' + 'd'.repeat(64) },
    task: { id: 'task', prompt: 'Refactor the fixture.' },
    repetitions: 2,
    order: ['baseline', 'grace'],
    model: { id: 'fixture-model', providerOrder: ['fixture-provider'], allowFallbacks: false, maxTokens: 1_000 },
    agent: { maxSteps: 5, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 16_384 },
    commandExecutor: { image: 'fixture@sha256:' + 'a'.repeat(64), commands: { check: ['true'] }, readOnlyMounts: [] },
    functionalGate: { command: ['true'], readOnlyMounts: [] },
    evaluator: {
      runner: { path: resolve(root, 'evaluate.mjs'), digest: 'sha256:' + 'c'.repeat(64) },
      command: ['fixture', '{runner}', '{candidate}', '{rulePack}', '{result}'],
      rulePack: { id: 'fixture', version: '1', digest: 'sha256:' + 'b'.repeat(64), path: resolve(root, 'rules.cjs') },
    },
    grace: { mcpUrl: 'https://grace.example/mcp', tokenEnv: 'GRACE_MCP_TOKEN' },
    outputDirectory: output,
    bootstrapSamples: 1_000,
    seed: 7,
  }
  const evaluated: string[] = []

  const result = await runCampaign(manifest, {
    verifyTarget: async () => {},
    prepareWorkspace: async (workspace) => cp(target, workspace, { recursive: true }),
    runAgent: async (input) => {
      await writeFile(resolve(input.workspace, 'candidate.txt'), `${input.condition}\n`)
      return {
        status: 'completed',
        error: null,
        model: 'fixture-model',
        provider: 'fixture-provider',
        promptTokens: 10,
        completionTokens: 5,
        cost: 0.01,
        trace: [{ condition: input.condition }],
      }
    },
    runFunctionalGate: async (workspace) => {
      if (workspace.endsWith('pair-02-baseline')) await writeFile(resolve(workspace, 'candidate.txt'), 'gate mutation\n')
      return { passed: true }
    },
    evaluate: async (workspace, pairId, condition) => {
      evaluated.push(`${pairId}-${condition}`)
      if (pairId === 'pair-02' && condition === 'grace') await writeFile(resolve(workspace, 'candidate.txt'), 'evaluator mutation\n')
      const qualityScore = condition === 'grace' ? 0.8 : 0.2
      const violations = condition === 'grace' ? 0 : 1
      return {
        status: condition === 'grace' ? 'passing' : 'failing',
        violations,
        qualityScore,
        qualityQualified: condition === 'grace',
        dimensions: {
          architecture: qualityScore,
          maintainability: qualityScore,
          clarity: qualityScore,
          tests: qualityScore,
          robustness: qualityScore,
        },
        evidence: buildQualityEvidence(qualityScore, violations),
      }
    },
  })

  assert.equal(result.records.length, 4)
  assert.equal(result.aggregate.functionalPairedAttempts, 2)
  assert.equal(result.aggregate.qualityPairedAttempts, 1)
  assert.ok(Math.abs((result.aggregate.graceCodeQualityDeltaMean ?? 0) - 0.6) < 1e-12)
  assert.equal(result.aggregate.baseline.functionalPassAt1, 0.5)
  assert.equal(result.aggregate.baseline.codeQualityMean, 0.1)
  assert.deepEqual(result.records.map((record) => record.condition), ['baseline', 'grace', 'grace', 'baseline'])
  assert.equal(result.aggregate.grace.functionalPassAt1, 1)
  assert.equal(result.aggregate.grace.qualityPassAt1, 1)
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'baseline')?.codeQualityScore, null)
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'baseline')?.status, 'functional_failed')
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'grace')?.status, 'evaluator_error')
  assert.deepEqual(evaluated, ['pair-01-baseline', 'pair-01-grace', 'pair-02-grace'])
  assert.match(result.records[0]?.candidateDigest ?? '', /^sha256:[0-9a-f]{64}$/)
  const persistedRun = JSON.parse(await readFile(resolve(output, 'runs/pair-01-baseline.json'), 'utf8')) as RunRecord
  assert.equal(persistedRun.qualityEvidence?.schemaVersion, 1)
  assert.equal(persistedRun.qualityEvidence?.dimensions[0]?.checks[0]?.id, 'architecture.fixture-1')
  assert.equal(persistedRun.qualityEvidence?.sources[0]?.path, 'src/fixture.ts')
  assert.match(persistedRun.qualityEvidence?.sources[0]?.digest ?? '', /^sha256:[0-9a-f]{64}$/)
  const failedRun = JSON.parse(await readFile(resolve(output, 'runs/pair-02-baseline.json'), 'utf8')) as RunRecord
  assert.equal(failedRun.qualityEvidence, null)
  const summary = await readFile(resolve(output, 'summary.md'), 'utf8')
  assert.match(summary, /Full check\/source\/graph report: `report\.md`/)
  assert.match(summary, /runs\/pair-01-baseline\.json/)

  const aggregate = JSON.parse(await readFile(resolve(output, 'aggregate.json'), 'utf8')) as Record<string, unknown>
  assert.equal(aggregate.campaignId, 'fixture-v2')
  assert.match(String(aggregate.manifestDigest), /^sha256:[0-9a-f]{64}$/)
})
test('records infrastructure failures and continues the pair', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-agent-error-'))
  const target = resolve(root, 'target')
  await mkdir(target)
  const manifest: CampaignManifest = {
    schemaVersion: 2,
    campaignId: 'agent-error-v2',
    target: { checkout: target, repository: 'fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: 'sha256:' + 'c'.repeat(64) },
    task: { id: 'task', prompt: 'Refactor.' },
    repetitions: 1,
    order: ['baseline', 'grace'],
    model: { id: 'fixture-model', providerOrder: ['fixture-provider'], allowFallbacks: false, maxTokens: 1_000 },
    agent: { maxSteps: 5, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 16_384 },
    commandExecutor: { image: 'fixture@sha256:' + 'd'.repeat(64), commands: { check: ['true'] }, readOnlyMounts: [] },
    functionalGate: { command: ['true'], readOnlyMounts: [] },
    evaluator: {
      runner: { path: resolve(root, 'evaluate.mjs'), digest: 'sha256:' + 'e'.repeat(64) },
      command: ['fixture', '{runner}', '{candidate}', '{rulePack}', '{result}'],
      rulePack: { id: 'fixture', version: '1', digest: 'sha256:' + 'f'.repeat(64), path: resolve(root, 'rules.cjs') },
    },
    grace: { mcpUrl: 'https://grace.example/mcp', tokenEnv: 'GRACE_MCP_TOKEN' },
    outputDirectory: resolve(root, 'results'),
    bootstrapSamples: 100,
    seed: 7,
  }

  const result = await runCampaign(manifest, {
    verifyTarget: async () => {},
    prepareWorkspace: async (workspace) => cp(target, workspace, { recursive: true }),
    runAgent: async () => { throw new Error('Grace unavailable') },
    runFunctionalGate: async () => { throw new Error('gate must not run') },
    evaluate: async () => { throw new Error('evaluator must not run') },
  })

  assert.deepEqual(result.records.map((record) => record.status), ['infrastructure_error', 'infrastructure_error'])
  assert.deepEqual(result.records.map((record) => record.agentError), ['Grace unavailable', 'Grace unavailable'])
  assert.equal(result.aggregate.baseline.codeQualityMean, null)
  assert.equal(result.aggregate.grace.codeQualityMean, null)
})
