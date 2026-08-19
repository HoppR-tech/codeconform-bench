import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseManifest } from '../src/manifest.js'

const valid = {
  schemaVersion: 1,
  campaignId: 'ohmyform-v1',
  target: { checkout: '/tmp/target', repository: 'HoppR-tech/ccb-ohmyform', commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: 'sha256:' + 'f'.repeat(64) },
  task: { id: 'clean-architecture', prompt: 'Refactor.', architectureIntent: 'Use ports and adapters.' },
  repetitions: 5,
  order: ['baseline', 'grace'],
  model: { id: 'openai/gpt-5.2-codex', providerOrder: ['OpenAI'], allowFallbacks: false, maxTokens: 32_000 },
  agent: { maxSteps: 40, maxTotalTokens: 200_000, maxToolOutputBytes: 131_072 },
  commandExecutor: { image: 'node@sha256:' + 'c'.repeat(64), commands: { check: ['npm', 'test'] }, readOnlyMounts: [] },
  functionalGate: { command: ['node', '/opt/ccb/probe/probe.cjs'], readOnlyMounts: [] },
  evaluator: {
    runner: { path: '/tmp/evaluate.mjs', digest: 'sha256:' + 'e'.repeat(64) },
    command: ['node', '{runner}', '--candidate', '{candidate}', '--rule-pack', '{rulePack}', '--result', '{result}'],
    rulePack: { id: 'ohmyform', version: '1', digest: 'sha256:' + 'd'.repeat(64), path: '/tmp/rules.cjs' },
  },
  graceContextDigest: 'sha256:' + 'a'.repeat(64),
  graceContextFile: '/tmp/grace.md',
  outputDirectory: '/tmp/results',
  bootstrapSamples: 10_000,
  seed: 42,
}

test('accepts a fully pinned campaign manifest', () => {
  assert.equal(parseManifest(valid).campaignId, 'ohmyform-v1')
})

test('rejects mutable execution inputs', () => {
  assert.throws(() => parseManifest({ ...valid, commandExecutor: { ...valid.commandExecutor, image: 'node:22' } }), /pinned by sha256/)
  assert.throws(() => parseManifest({
    ...valid,
    commandExecutor: {
      ...valid.commandExecutor,
      readOnlyMounts: [{ source: '/tmp/modules', target: '/workspace/api/node_modules', digest: 'mutable' }],
    },
  }), /digest must be sha256/)
  assert.throws(() => parseManifest({ ...valid, order: ['baseline', 'baseline'] }), /baseline and grace exactly once/)
  assert.throws(() => parseManifest({ ...valid, evaluator: { ...valid.evaluator, command: ['node', '{runner}', '{candidate}', '{result}'] } }), /\{rulePack\}/)
})
