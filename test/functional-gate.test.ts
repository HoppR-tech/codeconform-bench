import assert from 'node:assert/strict'
import { test } from 'node:test'
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

function gate(value: unknown): FunctionalGate {
  return new FunctionalGate({
    runCommand: async () => ({ exitCode: 0, signal: null, stdout: output(value), stderr: '', timedOut: false }),
  }, { command: ['probe'], readOnlyMounts: [] })
}

test('functional gate keeps assertions in the host process', async () => {
  assert.equal((await gate(expected).run('/candidate')).exitCode, 0)
  assert.equal((await gate({ ...expected, regular: { ...expected.regular, tokenHash: 'wrong' } }).run('/candidate')).exitCode, 1)
})
