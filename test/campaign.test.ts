import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { runCampaign } from '../src/campaign.js'
import type { CampaignManifest } from '../src/contracts.js'

const execFileAsync = promisify(execFile)

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
    schemaVersion: 1,
    campaignId: 'fixture-v1',
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
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    },
    evaluate: async (workspace, pairId, condition) => {
      evaluated.push(`${pairId}-${condition}`)
      if (pairId === 'pair-02' && condition === 'grace') await writeFile(resolve(workspace, 'candidate.txt'), 'evaluator mutation\n')
      return {
        status: 'passing',
        violations: condition === 'grace' ? 0 : 1,
        score: condition === 'grace' ? 0.8 : 0.2,
        weightedScore: condition === 'grace' ? 0.8 : 0.2,
      }
    },
  })

  assert.equal(result.records.length, 4)
  assert.equal(result.aggregate.completeScoredPairs, 1)
  assert.ok(Math.abs((result.aggregate.graceDeltaMedian ?? 0) - 0.6) < 1e-12)
  assert.equal(result.aggregate.baseline.functionalFailureRate, 0.5)
  assert.deepEqual(result.records.map((record) => record.condition), ['baseline', 'grace', 'grace', 'baseline'])
  assert.equal(result.aggregate.grace.functionalFailureRate, 0)
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'baseline')?.architectureScore, null)
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'baseline')?.status, 'functional_failed')
  assert.equal(result.records.find((record) => record.pairId === 'pair-02' && record.condition === 'grace')?.status, 'evaluator_error')
  assert.deepEqual(evaluated, ['pair-01-baseline', 'pair-01-grace', 'pair-02-grace'])
  assert.match(result.records[0]?.candidateDigest ?? '', /^sha256:[0-9a-f]{64}$/)

  const aggregate = JSON.parse(await readFile(resolve(output, 'aggregate.json'), 'utf8')) as Record<string, unknown>
  assert.equal(aggregate.campaignId, 'fixture-v1')
  assert.match(String(aggregate.manifestDigest), /^sha256:[0-9a-f]{64}$/)
})

test('records rejected agent runs and continues the pair', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-agent-error-'))
  const target = resolve(root, 'target')
  await mkdir(target)
  const manifest: CampaignManifest = {
    schemaVersion: 1,
    campaignId: 'agent-error-v1',
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

  assert.deepEqual(result.records.map((record) => record.status), ['agent_error', 'agent_error'])
  assert.deepEqual(result.records.map((record) => record.agentError), ['Grace unavailable', 'Grace unavailable'])
})
