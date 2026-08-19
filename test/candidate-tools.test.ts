import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { CandidateTools } from '../src/candidate-tools.js'

test('candidate tools stay inside the checkout and expose only named commands', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-'))
  await mkdir(resolve(root, 'src'))
  await writeFile(resolve(root, 'src', 'index.ts'), 'export const value = 1\n')
  const commands: string[] = []
  const tools = new CandidateTools(root, async (name) => {
    commands.push(name)
    if (name !== 'check') throw new Error('command is not approved')
    return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false }
  })

  assert.match(await tools.execute('read_file', JSON.stringify({ path: 'src/index.ts' })), /value = 1/)
  await tools.execute('write_file', JSON.stringify({ path: 'src/new.ts', content: 'export {}\n' }))
  assert.equal(await readFile(resolve(root, 'src', 'new.ts'), 'utf8'), 'export {}\n')
  await assert.rejects(tools.execute('read_file', JSON.stringify({ path: '../secret' })), /escapes candidate checkout/)
  await assert.rejects(tools.execute('run_command', JSON.stringify({ name: 'install' })), /not approved/)
  await assert.rejects(tools.execute('run_command', JSON.stringify({ name: 'check' })), /command limit/)
  assert.deepEqual(commands, ['install'])
})

test('candidate tools reject symlinks', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-symlink-'))
  await writeFile(resolve(root, 'file.ts'), 'export {}\n')
  await symlink(resolve(root, 'file.ts'), resolve(root, 'linked.ts'))
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }))
  await assert.rejects(tools.execute('list_files', JSON.stringify({ path: '.' })), /symbolic links are forbidden/)
})

test('candidate tools enforce a cumulative workspace quota', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-quota-'))
  await writeFile(resolve(root, 'large.bin'), '')
  await truncate(resolve(root, 'large.bin'), 32 * 1024 * 1024)
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }))
  await assert.rejects(tools.execute('write_file', JSON.stringify({ path: 'extra.txt', content: 'x' })), /workspace size limit/)
})
