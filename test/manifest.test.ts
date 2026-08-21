import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { parseManifest } from '../src/manifest.js'

const valid = {
  schemaVersion: 2,
  campaignId: 'ohmyform-v2',
  target: { checkout: '/tmp/target', repository: 'HoppR-tech/ccb-ohmyform', commit: 'a'.repeat(40), tree: 'b'.repeat(40), digest: 'sha256:' + 'f'.repeat(64) },
  task: { id: 'clean-architecture', prompt: 'Refactor.' },
  repetitions: 3,
  order: ['baseline', 'grace'],
  model: { id: 'openai/gpt-5.2-codex', providerOrder: ['OpenAI'], allowFallbacks: false, maxTokens: 32_000 },
  agent: { maxSteps: 40, maxCostUsd: 30, maxTotalTokens: 200_000, maxToolOutputBytes: 131_072 },
  commandExecutor: { image: 'node@sha256:' + 'c'.repeat(64), commands: { check: ['npm', 'test'] }, readOnlyMounts: [] },
  functionalGate: { command: ['node', '/opt/ccb/probe/probe.cjs'], readOnlyMounts: [] },
  evaluator: {
    runner: { path: '/tmp/evaluate.mjs', digest: 'sha256:' + 'e'.repeat(64) },
    command: ['node', '{runner}', '--candidate', '{candidate}', '--rule-pack', '{rulePack}', '--result', '{result}'],
    rulePack: { id: 'ohmyform', version: '2', digest: 'sha256:' + 'd'.repeat(64), path: '/tmp/rules.cjs' },
  },
  grace: { mcpUrl: 'https://grace.example/mcp', tokenEnv: 'GRACE_MCP_TOKEN' },
  outputDirectory: '/tmp/results',
  bootstrapSamples: 10_000,
  seed: 42,
}

const SEMANTIC_ACCEPTANCE_PARAGRAPH = 'Preserve these observable semantics: hash the input token through the injected hash dependency and store the returned hash; persist and return the exact submission instance passed to and returned from persistence; retain the form, user, and device for regular submissions; initialize elapsed time and completion percentage to zero; anonymize a supplied IP address; for anonymous submissions remove the user and apply the existing missing-IP fallback.'
const RUNNER_DIGEST = 'sha256:7388ec346e10e6706403a451d371f0c508bdfc99c4940614ac24928973318352'
const RULE_PACK_DIGEST = 'sha256:aea4997d5b24388a7866c4dc1ea6a414cef7f533057ce48f1a879b81a8a1cb3d'

test('accepts a fully pinned campaign manifest', () => {
  assert.equal(parseManifest(valid).campaignId, 'ohmyform-v2')
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
  assert.throws(() => parseManifest({ ...valid, grace: { ...valid.grace, mcpUrl: 'http://grace.example/mcp' } }), /must use HTTPS/)
  for (const maxCostUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseManifest({ ...valid, agent: { ...valid.agent, maxCostUsd } }), /agent\.maxCostUsd/)
  }
  assert.equal(parseManifest({ ...valid, repetitions: 3 }).repetitions, 3)
  assert.throws(() => parseManifest({ ...valid, repetitions: 4 }), /repetitions must be an integer between 3 and 3/)
  assert.throws(() => parseManifest({ ...valid, campaignId: 'x'.repeat(121) }), /campaignId must be a non-empty string of at most 120 characters/)
})

test('ships exactly eleven protocol-v3 manifests with identical semantic and evaluator contracts', async () => {
  const directory = resolve('campaigns')
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  const v3Entries = entries.filter((name) => /^ohmyform-v3(?:-|\.json)/.test(name))
  assert.equal(v3Entries.length, 11)
  assert.deepEqual(entries.filter((name) => /^ohmyform-v2(?:-|\.json)/.test(name)), [])

  const manifests = await Promise.all(v3Entries.map(async (name) => ({
    name,
    manifest: parseManifest(JSON.parse(await readFile(resolve(directory, name), 'utf8')) as unknown),
  })))
  const prompts = new Set(manifests.map(({ manifest }) => manifest.task.prompt))
  assert.equal(prompts.size, 1)
  for (const { name, manifest } of manifests) {
    assert.equal(manifest.schemaVersion, 2, name)
    assert.equal(manifest.agent.maxSteps, 120, name)
    assert.equal(manifest.task.id, 'submission-start-code-quality-v3', name)
    assert.equal(manifest.task.prompt.endsWith(`\n\n${SEMANTIC_ACCEPTANCE_PARAGRAPH}`), true, name)
    assert.match(manifest.campaignId, /^ohmyform-submission-start-v3(?:-|$)/, name)
    assert.match(manifest.outputDirectory, /\/ohmyform-submission-start-v3(?:-|$)/, name)
    assert.equal(manifest.evaluator.runner.digest, RUNNER_DIGEST, name)
    assert.equal(manifest.evaluator.rulePack.id, 'ohmyform-v2', name)
    assert.equal(manifest.evaluator.rulePack.version, '3', name)
    assert.equal(manifest.evaluator.rulePack.digest, RULE_PACK_DIGEST, name)
    assert.equal(
      manifest.evaluator.rulePack.path.endsWith('/.bench/evaluator/rule-packs/typescript/ohmyform-v2/dependency-cruiser.config.cjs'),
      true,
      name,
    )
    for (const forbidden of ['plain-token', 'hashed-token', 'CCB_RESULT', '/opt/ccb/probe']) {
      assert.doesNotMatch(manifest.task.prompt, new RegExp(forbidden), `${name}: ${forbidden}`)
    }
  }
})
