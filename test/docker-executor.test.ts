import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { DockerCommandExecutor } from '../src/docker-executor.js'
import { hashTree } from '../src/digest.js'

test('read-only mounts are rehashed before every execution', async () => {
  const source = await mkdtemp(resolve(tmpdir(), 'ccb-mount-'))
  await writeFile(resolve(source, 'dependency.js'), 'module.exports = 1\n')
  const digest = await hashTree(source, true)
  const executor = new DockerCommandExecutor({
    image: 'fixture@sha256:' + 'a'.repeat(64),
    commands: {},
    readOnlyMounts: [{ source, target: '/workspace/api/node_modules', digest }],
  })

  await executor.verify()
  await writeFile(resolve(source, 'dependency.js'), 'module.exports = 2\n')
  await assert.rejects(executor.verify(), /mount does not match manifest digest/)
})
