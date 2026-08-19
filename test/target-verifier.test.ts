import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { hashTree } from '../src/digest.js'
import { GitTargetVerifier } from '../src/target-verifier.js'

const execFileAsync = promisify(execFile)

test('materializes only the pinned Git tree', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-target-'))
  const repository = resolve(root, 'repository')
  const workspace = resolve(root, 'workspace')
  await execFileAsync('git', ['init', repository])
  await writeFile(resolve(repository, 'safe.txt'), 'pinned\n')
  await execFileAsync('git', ['-C', repository, 'add', 'safe.txt'])
  await execFileAsync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'])
  const [{ stdout: commit }, { stdout: tree }, digest] = await Promise.all([
    execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD']),
    execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD^{tree}']),
    hashTree(repository),
  ])
  await writeFile(resolve(repository, 'safe.txt'), 'dirty\n')
  await writeFile(resolve(repository, 'poison.txt'), 'untracked\n')

  const verifier = new GitTargetVerifier({
    checkout: repository,
    repository: 'fixture',
    commit: commit.trim(),
    tree: tree.trim(),
    digest,
  }, [])
  await verifier.verify()
  await verifier.materialize(workspace)

  assert.equal(await readFile(resolve(workspace, 'safe.txt'), 'utf8'), 'pinned\n')
  await assert.rejects(readFile(resolve(workspace, 'poison.txt'), 'utf8'))
})
