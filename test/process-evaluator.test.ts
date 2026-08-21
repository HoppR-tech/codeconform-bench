import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/digest.js'
import type { EvaluatorFailureCode, EvaluatorFailurePhase, EvaluatorResult } from '../src/contracts.js'
import { ProcessEvaluator } from '../src/process-evaluator.js'
import { buildQualityEvidence } from './evidence-fixture.js'

function assertFailure(
  result: EvaluatorResult,
  phase: EvaluatorFailurePhase,
  code: EvaluatorFailureCode,
  schemaPath?: string,
): void {
  assert.equal(result.status, 'evaluator_error')
  if (result.status !== 'evaluator_error') return
  assert.equal(result.diagnostic.phase, phase)
  assert.equal(result.diagnostic.code, code)
  if (schemaPath !== undefined) assert.equal(result.diagnostic.schemaPath, schemaPath)
  assert.ok(result.diagnostic.reason.length > 0)
  assert.ok(result.diagnostic.reason.length <= 240)
}

test('verifies digests and validates reconciled scoring evidence', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-'))
  const runner = resolve(root, 'evaluator.mjs')
  const rulePack = resolve(root, 'rules.cjs')
  const evidence = buildQualityEvidence(1)
  const evaluatorResult = {
    status: 'passing',
    violations: 0,
    qualityScore: 1,
    qualityQualified: true,
    dimensions: { architecture: 1, maintainability: 1, clarity: 1, tests: 1, robustness: 1 },
    evidence,
  }
  const runnerContent = `import { writeFile } from 'node:fs/promises'; console.log('private diagnostics'); await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(evaluatorResult))});\n`
  await writeFile(rulePack, 'module.exports = {};\n')
  await writeFile(runner, runnerContent)
  const candidate = resolve(root, 'candidate')
  await mkdir(resolve(candidate, 'src/domain'), { recursive: true })
  await writeFile(resolve(candidate, 'src/domain/model.ts'), 'export const model = 1\n')
  const digest = sha256('module.exports = {};\n')
  const evaluator = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: runner, digest: sha256(runnerContent) },
    rulePack: { id: 'ohmyform-v2', version: '2', digest, path: rulePack },
  }, resolve(root, 'results'))

  assert.deepEqual(await evaluator.evaluate(candidate, 'pair-01', 'baseline'), evaluatorResult)

  function resultWithTotalChecks(totalChecks: number) {
    const expanded = structuredClone(evaluatorResult)
    const architecture = expanded.evidence.dimensions[0]!
    const additions = totalChecks - expanded.evidence.dimensions.reduce((total, dimension) => total + dimension.checks.length, 0)
    for (let index = 0; index < additions; index += 1) {
      const check = structuredClone(architecture.checks[0]!)
      check.id = `architecture.budget-${index + 1}`
      architecture.checks.push(check)
    }
    architecture.earned += additions
    architecture.max += additions
    return expanded
  }

  const maximumRunner = resolve(root, 'maximum-checks-evaluator.mjs')
  const maximumResult = resultWithTotalChecks(35)
  const maximumContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(maximumResult))});\n`
  await writeFile(maximumRunner, maximumContent)
  const maximum = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: maximumRunner, digest: sha256(maximumContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'maximum-checks'))
  assert.deepEqual(await maximum.evaluate(candidate, 'pair-01', 'baseline'), maximumResult)

  const excessiveRunner = resolve(root, 'excessive-checks-evaluator.mjs')
  const excessiveResult = resultWithTotalChecks(36)
  const excessiveContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(excessiveResult))});\n`
  await writeFile(excessiveRunner, excessiveContent)
  const excessive = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: excessiveRunner, digest: sha256(excessiveContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'excessive-checks'))
  assertFailure(await excessive.evaluate(candidate, 'pair-01', 'baseline'), 'result_schema', 'result_schema_invalid', '$.evidence')

  const inconsistentRunner = resolve(root, 'inconsistent-evaluator.mjs')
  const inconsistentContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify({ ...evaluatorResult, qualityScore: 0.5 }))});\n`
  await writeFile(inconsistentRunner, inconsistentContent)
  const inconsistent = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: inconsistentRunner, digest: sha256(inconsistentContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'inconsistent'))
  assertFailure(await inconsistent.evaluate(candidate, 'pair-01', 'baseline'), 'result_schema', 'result_schema_invalid', '$.evidence')

  const unsafeRunner = resolve(root, 'unsafe-evaluator.mjs')
  const unsafeResult = structuredClone(evaluatorResult)
  unsafeResult.evidence.dimensions[0]!.checks[0]!.locations[0]!.path = '/tmp/host-secret'
  const unsafeContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(unsafeResult))});\n`
  await writeFile(unsafeRunner, unsafeContent)
  const unsafe = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: unsafeRunner, digest: sha256(unsafeContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'unsafe'))
  assertFailure(await unsafe.evaluate(candidate, 'pair-01', 'baseline'), 'result_schema', 'result_schema_invalid', '$.evidence')

  const unicodeRunner = resolve(root, 'unicode-evaluator.mjs')
  const unicodeResult = structuredClone(evaluatorResult)
  const unicodePath = 'src/nested folder/élan.ts'
  for (const dimension of unicodeResult.evidence.dimensions) {
    for (const check of dimension.checks) {
      for (const location of check.locations) location.path = unicodePath
    }
  }
  unicodeResult.evidence.inventory.files[0]!.path = unicodePath
  unicodeResult.evidence.sources[0]!.path = unicodePath
  unicodeResult.evidence.structure.nodes[0] = unicodePath
  const unicodeContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(unicodeResult))});\n`
  await writeFile(unicodeRunner, unicodeContent)
  const unicode = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: unicodeRunner, digest: sha256(unicodeContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'unicode'))
  assert.deepEqual(await unicode.evaluate(candidate, 'pair-01', 'baseline'), unicodeResult)

  const leakedRunner = resolve(root, 'leaked-evaluator.mjs')
  const leakedResult = structuredClone(evaluatorResult)
  leakedResult.evidence.sources[0]!.content = 'const endpoint = \"https://user:hunter2@example.com\"'
  leakedResult.evidence.sources[0]!.lineCount = 1
  leakedResult.evidence.inventory.files[0]!.lines = 1
  const leakedContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(leakedResult))});\n`
  await writeFile(leakedRunner, leakedContent)
  const leaked = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: leakedRunner, digest: sha256(leakedContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'leaked'))
  const sanitized = await leaked.evaluate(candidate, 'pair-01', 'baseline')
  assert.equal(sanitized.status, 'passing', JSON.stringify(sanitized))
  if (sanitized.status !== 'passing') return
  assert.doesNotMatch(sanitized.evidence.sources[0]?.content ?? '', /hunter2/)
  assert.match(sanitized.evidence.sources[0]?.content ?? '', /\[REDACTED\]/)

  const truncatedRunner = resolve(root, 'truncated-evaluator.mjs')
  const truncatedResult = structuredClone(evaluatorResult)
  const firstCheck = truncatedResult.evidence.dimensions[0]!.checks[0]!
  firstCheck.paths = [{ nodes: ['src/one.ts', 'src/two.ts'], totalNodes: 3, truncated: true }]
  firstCheck.pathCount = 1
  const truncatedContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(truncatedResult))});\n`
  await writeFile(truncatedRunner, truncatedContent)
  const truncated = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: truncatedRunner, digest: sha256(truncatedContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'truncated'))
  assertFailure(await truncated.evaluate(candidate, 'pair-01', 'baseline'), 'result_schema', 'result_schema_invalid', '$.evidence')

  const rejected = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: runner, digest: sha256(runnerContent) },
    rulePack: { id: 'ohmyform-v2', version: '2', digest: 'sha256:' + '0'.repeat(64), path: rulePack },
  }, resolve(root, 'rejected'))
  assertFailure(await rejected.evaluate(candidate, 'pair-01', 'baseline'), 'integrity', 'rule_pack_digest_mismatch')
})

test('retains bounded diagnostics for every evaluator failure phase and code', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-diagnostics-'))
  const candidate = resolve(root, 'candidate')
  const rulePack = resolve(root, 'rules.cjs')
  await mkdir(candidate)
  await writeFile(resolve(candidate, 'source.ts'), 'export const value = 1\n')
  await writeFile(rulePack, 'module.exports = {};\n')
  const ruleDigest = sha256('module.exports = {};\n')

  async function scenario(
    name: string,
    runnerContent: string,
    options: {
      command?: string[]
      runnerDigest?: string
      rulePackDigest?: string
      timeoutMs?: number
    } = {},
  ): Promise<{ result: EvaluatorResult; output: string }> {
    const runner = resolve(root, `${name}.mjs`)
    const output = resolve(root, `output-${name}`)
    await writeFile(runner, runnerContent)
    const evaluator = new ProcessEvaluator({
      command: options.command ?? [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
      runner: { path: runner, digest: options.runnerDigest ?? sha256(runnerContent) },
      rulePack: { id: 'fixture', version: '1', path: rulePack, digest: options.rulePackDigest ?? ruleDigest },
    }, output, options.timeoutMs ?? 2_000)
    return { result: await evaluator.evaluate(candidate, 'pair-01', 'baseline'), output }
  }

  const validResult = JSON.stringify({
    status: 'passing',
    violations: 0,
    qualityScore: 2,
    qualityQualified: true,
    dimensions: {},
    evidence: {},
  })
  const writes = (body: string) => `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${body});\n`

  const runnerMismatch = await scenario('runner-mismatch', '', { runnerDigest: 'sha256:' + '0'.repeat(64) })
  assertFailure(runnerMismatch.result, 'integrity', 'runner_digest_mismatch')
  const ruleMismatch = await scenario('rule-mismatch', '', { rulePackDigest: 'sha256:' + '0'.repeat(64) })
  assertFailure(ruleMismatch.result, 'integrity', 'rule_pack_digest_mismatch')
  const commandMissing = await scenario('command-missing', '', { command: [] })
  assertFailure(commandMissing.result, 'command', 'command_missing')

  const timeout = await scenario(
    'timeout',
    'const { promise } = Promise.withResolvers(); await promise;\n',
    { timeoutMs: 20 },
  )
  assertFailure(timeout.result, 'process', 'process_timeout')
  if (timeout.result.status === 'evaluator_error') assert.equal(timeout.result.diagnostic.timedOut, true)
  const signal = await scenario('signal', 'process.kill(process.pid, "SIGTERM");\n')
  assertFailure(signal.result, 'process', 'process_signal')
  if (signal.result.status === 'evaluator_error') assert.equal(signal.result.diagnostic.signal, 'SIGTERM')
  const secret = 'definitely-secret-value'
  const exited = await scenario('exit', `console.error('token="${secret}" /Users/alex/private ${'x'.repeat(4_096)}'); process.exit(7);\n`)
  assertFailure(exited.result, 'process', 'process_exit')
  if (exited.result.status === 'evaluator_error') {
    assert.equal(exited.result.diagnostic.exitCode, 7)
    assert.ok((exited.result.diagnostic.stderr?.length ?? 0) <= 2_048)
    assert.doesNotMatch(exited.result.diagnostic.stderr ?? '', /definitely-secret|\/Users|alex/)
  }

  const missing = await scenario('missing', 'void 0;\n')
  assertFailure(missing.result, 'result_read', 'result_missing')
  const tooLarge = await scenario('too-large', writes("'x'.repeat(16 * 1024 * 1024 + 1)"))
  assertFailure(tooLarge.result, 'result_read', 'result_too_large')
  const invalidJson = await scenario('invalid-json', writes(JSON.stringify(`token=\"${secret}\" /Users/alex/private not-json`)))
  assertFailure(invalidJson.result, 'result_parse', 'result_invalid_json')
  const invalidSchema = await scenario('invalid-schema', writes(JSON.stringify(validResult)))
  assertFailure(invalidSchema.result, 'result_schema', 'result_schema_invalid', '$.qualityScore')

  const producerFailures: Array<[EvaluatorFailurePhase, EvaluatorFailureCode]> = [
    ['candidate_inspection', 'candidate_access_failed'],
    ['candidate_inspection', 'candidate_tree_invalid'],
    ['candidate_inspection', 'candidate_path_invalid'],
    ['candidate_inspection', 'candidate_limits_exceeded'],
    ['rule_pack', 'rule_pack_invalid'],
    ['dependency_analysis', 'dependency_analysis_failed'],
    ['source_analysis', 'source_analysis_failed'],
    ['serialization', 'serialization_failed'],
    ['internal', 'internal_error'],
  ]
  for (const [phase, code] of producerFailures) {
    const diagnosticResult = JSON.stringify({
      status: 'evaluator_error',
      diagnostic: {
        schemaVersion: 1,
        phase,
        code,
        reason: `token="${secret}" /Users/alex/private ${'r'.repeat(80)}`,
      },
    })
    const produced = await scenario(`${phase}-${code}`, writes(JSON.stringify(diagnosticResult)))
    assertFailure(produced.result, phase, code)
    if (produced.result.status === 'evaluator_error') {
      assert.doesNotMatch(produced.result.diagnostic.reason, /definitely-secret|\/Users|alex/)
    }
  }

  const failureArtifact = await readFile(
    resolve(exited.output, 'evaluator/pair-01-baseline.failure.json'),
    'utf8',
  )
  const resultArtifact = await readFile(
    resolve(invalidJson.output, 'evaluator/pair-01-baseline.result-sanitized.json'),
    'utf8',
  )
  assert.doesNotMatch(`${failureArtifact}${resultArtifact}`, /definitely-secret|\/Users|alex/)
  assert.ok(Buffer.byteLength(resultArtifact) < 66 * 1024)
})
