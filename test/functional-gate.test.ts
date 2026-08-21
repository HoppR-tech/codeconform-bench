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

test('functional gate returns deterministic bounded mismatch evidence in the host process', async () => {
  assert.deepEqual(await gateResult({}).run('/candidate'), {
    passed: true,
    phase: 'assertion',
    code: 'passed',
    detail: null,
    evidence: null,
  })

  const { formRetained: _removed, ...regular } = expected.regular
  const mismatch = await gateResult({
    stdout: output({
      ...expected,
      regular: {
        ...regular,
        'a/b~c': ['unexpected'],
        tokenHash: `token="${'s'.repeat(64)}" /Users/alex/private ${'long value '.repeat(30)}`,
      },
    }),
  }).run('/candidate')

  assert.equal(mismatch.code, 'assertion_mismatch')
  assert.equal(mismatch.evidence?.schemaVersion, 1)
  assert.equal(mismatch.evidence?.totalMismatchCount, 3)
  assert.equal(mismatch.evidence?.retainedMismatchCount, 3)
  assert.equal(mismatch.evidence?.truncated, false)
  assert.deepEqual(mismatch.evidence?.mismatches.map(({ path, kind }) => ({ path, kind })), [
    { path: '/regular/a~1b~0c', kind: 'unexpected' },
    { path: '/regular/formRetained', kind: 'missing' },
    { path: '/regular/tokenHash', kind: 'value' },
  ])
  assert.deepEqual(mismatch.evidence?.mismatches[0], {
    path: '/regular/a~1b~0c',
    kind: 'unexpected',
    expected: '<missing>',
    actual: '<array:length=1>',
  })
  assert.equal(mismatch.evidence?.mismatches[1]?.actual, '<missing>')
  assert.ok((mismatch.evidence?.redactions ?? 0) >= 2)
  assert.equal(mismatch.evidence?.valuesTruncated, 1)
  assert.doesNotMatch(JSON.stringify(mismatch.evidence), /s{20}|\/Users\/alex/)
})

test('functional gate distinguishes command exit, signal, and timeout with bounded redacted stderr', async () => {
  const exit = await gateResult({ exitCode: 7, stderr: 'failed' }).run('/candidate')
  assert.deepEqual(exit, { passed: false, phase: 'command', code: 'command_exit', detail: 'exit 7: failed', evidence: null })
  const signal = await gateResult({ exitCode: null, signal: 'SIGTERM' }).run('/candidate')
  assert.deepEqual(signal, { passed: false, phase: 'command', code: 'command_signal', detail: 'SIGTERM', evidence: null })
  const timeout = await gateResult({
    exitCode: null,
    signal: 'SIGKILL',
    timedOut: true,
    stderr: `token=\"${'s'.repeat(64)}\" /Users/private/workspace ${'x'.repeat(4_096)}`,
  }).run('/candidate')
  assert.equal(timeout.code, 'command_timeout')
  assert.ok((timeout.detail?.length ?? 0) <= 2_048)
  assert.equal(timeout.evidence, null)
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
      evidence: null,
    })
  }
})

test('functional gate distinguishes type and array element mismatches', async () => {
  const result = await gateResult({
    stdout: output({
      ...expected,
      regular: {
        ...expected.regular,
        devicePreserved: [true, false],
      },
    }),
  }).run('/candidate')

  assert.deepEqual(result.evidence?.mismatches, [{
    path: '/regular/devicePreserved',
    kind: 'type',
    expected: 'true',
    actual: '<array:length=2>',
  }])
})

test('functional gate retains only the first sixteen lexicographically ordered mismatches', async () => {
  const extras = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `extra-${String(index).padStart(2, '0')}`,
    index,
  ]))
  const result = await gateResult({ stdout: output({ ...extras, ...expected }) }).run('/candidate')

  assert.equal(result.evidence?.totalMismatchCount, 20)
  assert.equal(result.evidence?.retainedMismatchCount, 16)
  assert.equal(result.evidence?.truncated, true)
  assert.deepEqual(
    result.evidence?.mismatches.map(({ path }) => path),
    Array.from({ length: 16 }, (_, index) => `/extra-${String(index).padStart(2, '0')}`),
  )
})

test('functional gate rejects payloads over byte, node, and depth limits', async () => {
  const overBytes = await gateResult({ stdout: output('x'.repeat(256 * 1024 + 1)) }).run('/candidate')
  assert.deepEqual(overBytes, {
    passed: false,
    phase: 'probe',
    code: 'probe_payload_limits_exceeded',
    detail: 'functional probe payload exceeded diagnostic limits',
    evidence: null,
  })

  const overNodes = await gateResult({
    stdout: output(Array.from({ length: 10_000 }, () => null)),
  }).run('/candidate')
  assert.equal(overNodes.code, 'probe_payload_limits_exceeded')
  assert.equal(overNodes.evidence, null)

  let nested: unknown = null
  for (let depth = 0; depth < 33; depth += 1) nested = [nested]
  const overDepth = await gateResult({ stdout: output(nested) }).run('/candidate')
  assert.equal(overDepth.code, 'probe_payload_limits_exceeded')
  assert.equal(overDepth.evidence, null)
})
