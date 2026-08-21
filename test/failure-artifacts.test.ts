import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { writeCandidateRecoveryArtifact } from '../src/failure-artifacts.js'

test('candidate recovery patch is bounded, redacted, candidate-relative, and replayable', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-recovery-'))
  const base = resolve(root, 'base')
  const candidate = resolve(root, 'candidate')
  await mkdir(resolve(base, 'src'), { recursive: true })
  await writeFile(resolve(base, 'src/value.ts'), 'export const value = 1\n')
  await writeFile(resolve(base, 'src/deleted.ts'), 'export const removed = true\n')
  await cp(base, candidate, { recursive: true })
  await writeFile(
    resolve(candidate, 'src/value.ts'),
    'const token="definitely-secret-value"\nconst host="/Users/alex/private/file"\nexport const value = 2\n',
  )
  await writeFile(resolve(candidate, '.env'), 'OPENROUTER_API_KEY=definitely-secret-value\n')
  await writeFile(resolve(candidate, 'src/added.ts'), 'export const added = true\n')
  await rm(resolve(candidate, 'src/deleted.ts'))
  const output = resolve(root, 'candidate-recovery.json')
  const metadata = await writeCandidateRecoveryArtifact({
    baseRoot: base,
    candidateRoot: candidate,
    outputPath: output,
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    candidateDigest: 'sha256:' + 'c'.repeat(64),
  })
  const text = await readFile(output, 'utf8')
  const artifact = JSON.parse(text) as {
    complete: boolean
    redactions: number
    operations: Array<{ operation: string; path: string; content?: string }>
    omitted: Array<{ path: string; reason: string }>
  }
  assert.equal(artifact.complete, false)
  assert.ok(artifact.redactions >= 2)
  assert.deepEqual(
    artifact.operations.map(({ operation, path }) => [operation, path]),
    [['write', 'src/added.ts'], ['delete', 'src/deleted.ts'], ['write', 'src/value.ts']],
  )
  assert.deepEqual(artifact.omitted, [{ path: '.env', reason: 'sensitive_path' }])
  assert.doesNotMatch(text, /definitely-secret-value|\/Users|alex\/private/)
  assert.match(text, /\[REDACTED\]/)
  assert.match(text, /\[REDACTED_PATH\]/)
  assert.ok(Buffer.byteLength(text) < 2.1 * 1024 * 1024)
  assert.deepEqual(metadata, {
    complete: false,
    redactions: artifact.redactions,
    omittedUnsafePathCount: 0,
    operationCount: 3,
    omittedCount: 1,
  })
})
