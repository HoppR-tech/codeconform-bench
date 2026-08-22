#!/usr/bin/env node
// Stage-A smoke: end-to-end proof of the §4.1 tool surface against a real
// Docker executor, no paid calls. Materializes the pagination fixture in a
// tmpdir, then drives find_files -> read_file(offset/limit) -> edit -> grep
// -> run_command x2 through CandidateTools with maxCommandCalls: 2.
//
// Exit codes: 0 = smoke passed; 3 = Docker unavailable (unit tests remain
// the proof of record); 1 = assertion failure.
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CandidateTools } from '../dist/src/candidate-tools.js'
import { DockerCommandExecutor } from '../dist/src/docker-executor.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'node@sha256:cd59a61258b82b86c1ff0ead50c8a689f6c3483c5ed21036e11ee741add419eb'

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
    process.exit(1)
  }
  console.log(`ok   ${label}`)
}

async function main() {
  let dockerAvailable = true
  try {
    const { execFile } = await import('node:child_process')
    await new Promise((resolvePromise, reject) => {
      execFile('docker', ['info'], (error) => error ? reject(error) : resolvePromise())
    })
  } catch {
    dockerAvailable = false
  }
  if (!dockerAvailable) {
    console.error('Docker unavailable: skipping tool-surface smoke. Unit tests remain the proof of record.')
    process.exit(3)
  }

  const workspace = await mkdtemp(resolve(tmpdir(), 'ccb-smoke-'))
  await cp(resolve(root, 'fixtures/ts-micro/pagination'), workspace, { recursive: true })

  const executor = new DockerCommandExecutor({
    image: IMAGE,
    commands: { check: ['node', '--test'] },
    readOnlyMounts: [],
  })
  const tools = new CandidateTools(workspace, (name) => executor.runNamed(workspace, name), new Set(['check']), 2)

  try {
    const found = await tools.execute('find_files', JSON.stringify({ glob: '*.js', path: '.' }))
    assertEqual(found, 'pages.js', 'find_files lists pages.js')
    const window = await tools.execute('read_file', JSON.stringify({ path: 'pages.js', offset: 10, limit: 3 }))
    assertEqual(window.split('\n')[0], "  if (!Number.isInteger(totalItems) || totalItems < 0) throw new TypeError('totalItems must be a non-negative integer')", 'read_file offset/limit window starts at line 10')

    const edited = await tools.execute('edit', JSON.stringify({ path: 'package.json', old_string: '"check": "node --test"', new_string: '"check": "node --test --test-reporter=spec"' }))
    assertEqual(edited, 'edited', 'edit rewrites package.json script')

    const grep = await tools.execute('grep', JSON.stringify({ pattern: 'pageWindow', include: '*.js' }))
    assertEqual(grep.startsWith('pages.js:'), true, 'grep finds pageWindow in pages.js')

    for (let run = 1; run <= 2; run += 1) {
      const result = JSON.parse(await tools.execute('run_command', JSON.stringify({ name: 'check' })))
      assertEqual(typeof result.exitCode, 'number', `run_command #${run} executed`)
    }
    try {
      await tools.execute('run_command', JSON.stringify({ name: 'check' }))
      console.error('FAIL third run_command should have been rejected')
      process.exit(1)
    } catch (error) {
      assertEqual(error.diagnostic?.code, 'command_limit_exceeded', 'third run_command rejected with command_limit_exceeded')
    }
    console.log('\nsmoke passed: full §4.1 surface exercised over Docker')
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
