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

test('read_file returns bounded 1-based line windows', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-read-'))
  await writeFile(resolve(root, 'lines.txt'), Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n') + '\n')
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  assert.match(await tools.execute('read_file', JSON.stringify({ path: 'lines.txt' })), /line-10/)
  assert.equal(await tools.execute('read_file', JSON.stringify({ path: 'lines.txt', offset: 3, limit: 2 })), 'line-3\nline-4\n… 6 more lines')
  assert.equal(await tools.execute('read_file', JSON.stringify({ path: 'lines.txt', offset: 9 })), 'line-9\nline-10')
  await assert.rejects(tools.execute('read_file', JSON.stringify({ path: 'lines.txt', offset: 0 })), /offset must be an integer >= 1/)
  await assert.rejects(tools.execute('read_file', JSON.stringify({ path: 'lines.txt', limit: 1.5 })), /limit must be an integer >= 1/)
  await assert.rejects(tools.execute('read_file', JSON.stringify({ path: 'lines.txt', offset: 99 })), /beyond end of file/)
})

test('edit replaces exact matches and reports ambiguous locations', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-edit-'))
  await writeFile(resolve(root, 'code.ts'), 'const a = 1;\nconst a = 2;\n')
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  await assert.rejects(tools.execute('edit', JSON.stringify({ path: 'code.ts', old_string: 'missing', new_string: 'x' })), /old_string not found/)
  await assert.rejects(tools.execute('edit', JSON.stringify({ path: 'code.ts', old_string: 'const a = ', new_string: 'let a = ' })), /old_string matches 2 locations/)
  assert.equal(await tools.execute('edit', JSON.stringify({ path: 'code.ts', old_string: 'const a = 1;', new_string: 'const b = 1;' })), 'edited')
  assert.equal(await readFile(resolve(root, 'code.ts'), 'utf8'), 'const b = 1;\nconst a = 2;\n')
  assert.equal(await tools.execute('edit', JSON.stringify({ path: 'code.ts', old_string: 'const ', new_string: 'let ', replace_all: true })), 'edited')
  assert.equal(await readFile(resolve(root, 'code.ts'), 'utf8'), 'let b = 1;\nlet a = 2;\n')
})

test('grep bounds results, honors include filters, and rejects invalid patterns', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-grep-'))
  await mkdir(resolve(root, 'src'))
  for (let index = 0; index < 250; index += 1) {
    await writeFile(resolve(root, 'src', `gen-${String(index).padStart(3, '0')}.ts`), `needle ${index}\n`)
  }
  await writeFile(resolve(root, 'src', 'exact.ts'), 'const needle = 1;\nskipped\n')
  await writeFile(resolve(root, 'README.md'), 'needle in docs\n')
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  await assert.rejects(tools.execute('grep', JSON.stringify({ pattern: '(' })), /invalid grep pattern/)
  const filtered = await tools.execute('grep', JSON.stringify({ pattern: 'needle', include: '*.md' }))
  assert.equal(filtered, 'README.md:1:needle in docs')
  const single = await tools.execute('grep', JSON.stringify({ pattern: 'const needle' }))
  assert.equal(single, 'src/exact.ts:1:const needle = 1;')
  const bounded = await tools.execute('grep', JSON.stringify({ pattern: 'needle' }))
  const lines = bounded.split('\n')
  assert.equal(lines.length, 201)
  assert.equal(lines[200], '… results truncated')
})

test('find_files matches glob patterns over relative paths', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-find-'))
  await mkdir(resolve(root, 'src/nested'), { recursive: true })
  await writeFile(resolve(root, 'top.ts'), '')
  await writeFile(resolve(root, 'src', 'mid.ts'), '')
  await writeFile(resolve(root, 'src', 'nested', 'deep.ts'), '')
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  assert.equal(await tools.execute('find_files', JSON.stringify({ glob: '**/*.ts' })), 'src/mid.ts\nsrc/nested/deep.ts')
  assert.equal(await tools.execute('find_files', JSON.stringify({ glob: '*.ts' })), 'top.ts')
  assert.equal(await tools.execute('find_files', JSON.stringify({ glob: 'src/*.ts' })), 'src/mid.ts')
})

test('grep and find_files skip symlinks instead of failing', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-link-'))
  await mkdir(resolve(root, 'outside'))
  await writeFile(resolve(root, 'outside', 'secret.ts'), 'needle\n')
  await writeFile(resolve(root, 'local.ts'), 'needle here\n')
  await symlink(resolve(root, 'outside'), resolve(root, 'linked'))
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  assert.equal(await tools.execute('grep', JSON.stringify({ pattern: 'needle' })), 'local.ts:1:needle here\noutside/secret.ts:1:needle')
  assert.equal(await tools.execute('find_files', JSON.stringify({ glob: '**/*.ts' })), 'outside/secret.ts')
  assert.equal(await tools.execute('find_files', JSON.stringify({ glob: '*.ts' })), 'local.ts')
})

test('run_command honors the configured call budget', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-budget-'))
  const commands: string[] = []
  const tools = new CandidateTools(root, async (name) => {
    commands.push(name)
    return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false }
  }, new Set(['check']), 2)

  await tools.execute('run_command', JSON.stringify({ name: 'check' }))
  await tools.execute('run_command', JSON.stringify({ name: 'check' }))
  await assert.rejects(tools.execute('run_command', JSON.stringify({ name: 'check' })), (error: unknown) => {
    assert.ok(error instanceof CandidateCommandError)
    assert.equal(error.diagnostic.code, 'command_limit_exceeded')
    return true
  })
  assert.deepEqual(commands, ['check', 'check'])
})

test('walk entry cap marks find_files and grep output as truncated', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-tools-walkcap-'))
  await mkdir(resolve(root, 'many'))
  for (let index = 0; index < 5_100; index += 1) {
    await writeFile(resolve(root, 'many', `f-${String(index).padStart(5, '0')}.txt`), `needle ${index}\n`)
  }
  const tools = new CandidateTools(root, async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }), new Set())

  const found = await tools.execute('find_files', JSON.stringify({ glob: '**/*.txt' }))
  const foundLines = found.split('\n')
  assert.equal(foundLines[foundLines.length - 1], '… truncated')
  assert.ok(foundLines.length <= 5_001)

  const grepped = await tools.execute('grep', JSON.stringify({ pattern: 'needle' }))
  const grepLines = grepped.split('\n')
  assert.equal(grepLines[grepLines.length - 1], '… results truncated')
})
