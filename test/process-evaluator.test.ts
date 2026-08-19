import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { sha256 } from '../src/digest.js'
import { ProcessEvaluator } from '../src/process-evaluator.js'


test('verifies the rule-pack digest and returns only aggregate scores', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-'))
  const runner = resolve(root, 'evaluator.mjs')
  const rulePack = resolve(root, 'rules.cjs')
  const runnerContent = "import { writeFile } from 'node:fs/promises'; console.log('private diagnostics'); await writeFile(process.argv[4], JSON.stringify({ status: 'passing', violations: 0, score: 1, weightedScore: 1 }));\n"
  await writeFile(rulePack, 'module.exports = {};\n')
  await writeFile(runner, runnerContent)
  const candidate = resolve(root, 'candidate')
  await mkdir(resolve(candidate, 'src/domain'), { recursive: true })
  await writeFile(resolve(candidate, 'src/domain/model.ts'), 'export const model = 1\n')
  const digest = sha256('module.exports = {};\n')
  const evaluator = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: runner, digest: sha256(runnerContent) },
    rulePack: { id: 'ohmyform-v1', version: '1', digest, path: rulePack },
  }, resolve(root, 'results'))

  assert.deepEqual(await evaluator.evaluate(candidate, 'pair-01', 'baseline'), {
    status: 'passing',
    violations: 0,
    score: 1,
    weightedScore: 1,
  })

  const rejected = new ProcessEvaluator({
    command: [process.execPath, '{runner}', '{candidate}', '{rulePack}', '{result}'],
    runner: { path: runner, digest: sha256(runnerContent) },
    rulePack: { id: 'ohmyform-v1', version: '1', digest: 'sha256:' + '0'.repeat(64), path: rulePack },
  }, resolve(root, 'rejected'))
  assert.deepEqual(await rejected.evaluate(candidate, 'pair-01', 'baseline'), { status: 'evaluator_error' })
})
