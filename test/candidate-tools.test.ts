import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { CandidateCommandError, CandidateTools } from '../src/candidate-tools.js'

test('candidate tools stay inside the checkout and expose only named commands', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-'))
  await mkdir(resolve(root, 'src'))
  await writeFile(resolve(root, 'src', 'index.ts'), 'export const value = 1\n')
  const commands: string[] = []
  const tools = new CandidateTools(root, async (name) => {
    commands.push(name)
    return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false }
  }, new Set(['check']))

  assert.match(await tools.execute('read_file', JSON.stringify({ path: 'src/index.ts' })), /value = 1/)
  await tools.execute('write_file', JSON.stringify({ path: 'src/new.ts', content: 'export {}\n' }))
  assert.equal(await readFile(resolve(root, 'src', 'new.ts'), 'utf8'), 'export {}\n')
  await assert.rejects(tools.execute('read_file', JSON.stringify({ path: '../secret' })), /escapes candidate checkout/)
  await assert.rejects(tools.execute('run_command', JSON.stringify({ name: 'install' })), (error: unknown) => {
    assert.ok(error instanceof CandidateCommandError)
    assert.deepEqual(error.diagnostic, {
      command: null,
      code: 'command_not_approved',
      exitCode: null,
      signal: null,
      timedOut: false,
      reason: 'requested command is not approved',
    })
    return true
  })
  await assert.rejects(tools.execute('run_command', JSON.stringify({ name: 'check' })), (error: unknown) => {
    assert.ok(error instanceof CandidateCommandError)
    assert.equal(error.diagnostic.code, 'command_limit_exceeded')
    assert.equal(error.diagnostic.command, 'check')
    return true
  })
  assert.deepEqual(commands, [])
})

test('candidate tools retain bounded approved-command outcomes without publishing output', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-command-'))
  const tools = new CandidateTools(root, async () => ({
    exitCode: 7,
    signal: null,
    stdout: 'token=\"secret-value-that-must-not-be-published\"',
    stderr: '/Users/private/workspace',
    timedOut: false,
  }), new Set(['api-check']))

  const content = await tools.execute('run_command', JSON.stringify({ name: 'api-check' }))

  assert.match(content, /secret-value/)
  assert.deepEqual(tools.takeCommandDiagnostics(), [{
    command: 'api-check',
    code: 'command_exit',
    exitCode: 7,
    signal: null,
    timedOut: false,
    reason: 'approved command exited non-zero',
  }])
  assert.deepEqual(tools.takeCommandDiagnostics(), [])
})

test('candidate tools reject symlinks', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-symlink-'))
  await writeFile(resolve(root, 'file.ts'), 'export {}\n')
  await symlink(resolve(root, 'file.ts'), resolve(root, 'linked.ts'))
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())
  await assert.rejects(tools.execute('list_files', JSON.stringify({ path: '.' })), /symbolic links are forbidden/)
})

test('candidate tools enforce a cumulative workspace quota', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-quota-'))
  await writeFile(resolve(root, 'large.bin'), '')
  await truncate(resolve(root, 'large.bin'), 32 * 1024 * 1024)
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())
  await assert.rejects(tools.execute('write_file', JSON.stringify({ path: 'extra.txt', content: 'x' })), /workspace size limit/)
})
