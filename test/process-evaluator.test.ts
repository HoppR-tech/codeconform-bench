import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/digest.js'
import { ProcessEvaluator } from '../src/process-evaluator.js'
import { buildQualityEvidence } from './evidence-fixture.js'


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
  assert.deepEqual(await excessive.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })

  const inconsistentRunner = resolve(root, 'inconsistent-evaluator.mjs')
  const inconsistentContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify({ ...evaluatorResult, qualityScore: 0.5 }))});\n`
  await writeFile(inconsistentRunner, inconsistentContent)
  const inconsistent = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: inconsistentRunner, digest: sha256(inconsistentContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'inconsistent'))
  assert.deepEqual(await inconsistent.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })

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
  assert.deepEqual(await unsafe.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })

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
  const leakedContent = `import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[4], ${JSON.stringify(JSON.stringify(leakedResult))});\n`
  await writeFile(leakedRunner, leakedContent)
  const leaked = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: leakedRunner, digest: sha256(leakedContent) },
    rulePack: { id: 'ohmyform-v2', version: '3', digest, path: rulePack },
  }, resolve(root, 'leaked'))
  assert.deepEqual(await leaked.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })

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
  assert.deepEqual(await truncated.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })

  const rejected = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: runner, digest: sha256(runnerContent) },
    rulePack: { id: 'ohmyform-v2', version: '2', digest: 'sha256:' + '0'.repeat(64), path: rulePack },
  }, resolve(root, 'rejected'))
  assert.deepEqual(await rejected.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })
})
