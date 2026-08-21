import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommandResult } from '../src/contracts.js'
import { FunctionalGate } from '../src/functional-gate.js'

const expected = {
  regular: {
    saved: true,
    hashedToken: 'plain-token',
    formRetained: true,
    userRetained: true,
    tokenHash: 'hashed-token',
    timeElapsed: 0,
    percentageComplete: 0,
    devicePreserved: true,
    ipAnonymized: true,
  },
  anonymous: { userRemoved: true, missingIp: '?' },
}

function output(value: unknown): string {
  return `CCB_READY trusted-nonce\nCCB_RESULT trusted-nonce ${Buffer.from(JSON.stringify(value)).toString('base64')}\n`
}

function gateResult(result: Partial<CommandResult>): FunctionalGate {
  return new FunctionalGate({
    runCommand: async () => ({
      exitCode: 0,
      signal: null,
      stdout: output(expected),
      stderr: '',
      timedOut: false,
      ...result,
    }),
  }, { command: ['probe'], readOnlyMounts: [] })
}

test('functional gate returns stable assertion diagnostics in the host process', async () => {
  assert.deepEqual(await gateResult({}).run('/candidate'), {
    passed: true,
    phase: 'assertion',
    code: 'passed',
    detail: null,
  })
  assert.deepEqual(await gateResult({
    stdout: output({ ...expected, regular: { ...expected.regular, tokenHash: 'wrong' } }),
  }).run('/candidate'), {
    passed: false,
    phase: 'assertion',
    code: 'assertion_mismatch',
    detail: 'functional result did not match the expected contract',
  })
})

test('functional gate distinguishes command exit, signal, and timeout with bounded redacted stderr', async () => {
  const exit = await gateResult({ exitCode: 7, stderr: 'failed' }).run('/candidate')
  assert.deepEqual(exit, { passed: false, phase: 'command', code: 'command_exit', detail: 'exit 7: failed' })
  const signal = await gateResult({ exitCode: null, signal: 'SIGTERM' }).run('/candidate')
  assert.deepEqual(signal, { passed: false, phase: 'command', code: 'command_signal', detail: 'SIGTERM' })
  const timeout = await gateResult({
    exitCode: null,
    signal: 'SIGKILL',
    timedOut: true,
    stderr: `token=\"${'s'.repeat(64)}\" /Users/private/workspace ${'x'.repeat(4_096)}`,
  }).run('/candidate')
  assert.equal(timeout.code, 'command_timeout')
  assert.ok((timeout.detail?.length ?? 0) <= 2_048)
  assert.doesNotMatch(timeout.detail ?? '', /s{20}|\/Users|workspace/)
  assert.match(timeout.detail ?? '', /\[REDACTED\]/)
  assert.match(timeout.detail ?? '', /\[REDACTED_PATH\]/)
})

test('functional gate classifies every probe protocol failure', async () => {
  const cases: Array<[string, string, CommandResult['stdout']]> = [
    ['probe_ready_missing', 'functional probe omitted ready nonce', 'ordinary output\n'],
    ['probe_nonce_invalid', 'functional probe returned an invalid nonce', 'CCB_READY bad\n'],
    ['probe_result_missing', 'functional probe omitted nonce-bound result', 'CCB_READY trusted-nonce\n'],
    ['probe_payload_invalid', 'functional probe returned invalid base64', 'CCB_READY trusted-nonce\nCCB_RESULT trusted-nonce %%%\n'],
    ['probe_payload_invalid', 'functional probe returned invalid JSON', `CCB_READY trusted-nonce\nCCB_RESULT trusted-nonce ${Buffer.from('not json').toString('base64')}\n`],
  ]
  for (const [code, detail, stdout] of cases) {
    assert.deepEqual(await gateResult({ stdout }).run('/candidate'), {
      passed: false,
      phase: 'probe',
      code,
      detail,
    })
  }
})
