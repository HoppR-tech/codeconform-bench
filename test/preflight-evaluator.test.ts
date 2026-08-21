import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/digest.js'
import { runEvaluatorPreflight } from '../src/preflight-evaluator.js'
import { buildQualityEvidence } from './evidence-fixture.js'

function evaluatorResult(status: 'passing' | 'failing', score: number, violations: number) {
  return {
    status,
    violations,
    qualityScore: score,
    qualityQualified: status === 'passing',
    dimensions: { architecture: score, maintainability: score, clarity: score, tests: score, robustness: score },
    evidence: buildQualityEvidence(score, violations),
  }
}

async function fixture(): Promise<{ manifestPath: string; manifest: Record<string, unknown>; fixtures: string }> {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-preflight-test-'))
  const fixtures = resolve(root, 'fixtures')
  await mkdir(resolve(fixtures, 'passing'), { recursive: true })
  await mkdir(resolve(fixtures, 'failing'), { recursive: true })
  await writeFile(resolve(fixtures, 'passing/source.ts'), 'export const passing = true\n')
  await writeFile(resolve(fixtures, 'failing/source.ts'), 'export const passing = false\n')
  const runner = resolve(root, 'runner.mjs')
  const rulePack = resolve(root, 'rules.cjs')
  const passing = evaluatorResult('passing', 1, 0)
  const failing = evaluatorResult('failing', 0.4, 5)
  const runnerContent = `import { writeFile } from 'node:fs/promises'; const value = process.argv[2].endsWith('/passing') ? ${JSON.stringify(passing)} : ${JSON.stringify(failing)}; await writeFile(process.argv[4], JSON.stringify(value));\n`
  await writeFile(runner, runnerContent)
  await writeFile(rulePack, 'module.exports = {}\n')
  const manifest = {
    schemaVersion: 2,
    campaignId: 'preflight-fixture-v2',
    target: {
      checkout: resolve(root, 'target'),
      repository: 'fixture',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      digest: 'sha256:' + 'c'.repeat(64),
    },
    task: { id: 'fixture', prompt: 'Fixture task.' },
    repetitions: 3,
    order: ['baseline', 'grace'],
    model: { id: 'fixture', providerOrder: ['fixture'], allowFallbacks: false, maxTokens: 100 },
    agent: { maxSteps: 1, maxCostUsd: 1, maxTotalTokens: 100, maxToolOutputBytes: 1_024 },
    commandExecutor: { image: 'fixture@sha256:' + 'd'.repeat(64), commands: { check: ['true'] }, readOnlyMounts: [] },
    functionalGate: { command: ['true'], readOnlyMounts: [] },
    evaluator: {
      command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
      runner: { path: runner, digest: sha256(runnerContent) },
      rulePack: { id: 'fixture', version: '1', path: rulePack, digest: sha256('module.exports = {}\n') },
    },
    grace: { mcpUrl: 'https://grace.example/mcp', tokenEnv: 'GRACE_MCP_TOKEN' },
    outputDirectory: resolve(root, 'results'),
    bootstrapSamples: 100,
    seed: 7,
  }
  const manifestPath = resolve(root, 'campaign.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { manifestPath, manifest, fixtures }
}

test('preflight sends passing and failing fixtures through production ProcessEvaluator', async () => {
  const setup = await fixture()
  const result = await runEvaluatorPreflight(setup.manifestPath, setup.fixtures)
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.fixtures, { passing: 'passing', failing: 'failing' })
})

test('preflight fails closed when the exact evaluator pin does not match', async () => {
  const setup = await fixture()
  const evaluator = (setup.manifest.evaluator ?? {}) as Record<string, unknown>
  const runner = (evaluator.runner ?? {}) as Record<string, unknown>
  runner.digest = 'sha256:' + '0'.repeat(64)
  await writeFile(setup.manifestPath, JSON.stringify(setup.manifest))
  await assert.rejects(
    runEvaluatorPreflight(setup.manifestPath, setup.fixtures),
    /passing evaluator fixture did not pass \(integrity\/runner_digest_mismatch\)/,
  )
})
