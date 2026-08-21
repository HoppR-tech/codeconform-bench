import assert from 'node:assert/strict'
import type { CampaignManifest, CommandResult, FunctionalGateResult, ReadOnlyMount } from './contracts.js'
import { MAX_SAFE_STDERR_CHARACTERS, sanitizeText } from './safe-diagnostics.js'

interface GateExecutor {
  runCommand(workspace: string, command: readonly string[], mounts: readonly ReadOnlyMount[]): Promise<CommandResult>
}

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

export class FunctionalGate {
  constructor(
    private readonly executor: GateExecutor,
    private readonly config: CampaignManifest['functionalGate'],
  ) {}

  async run(workspace: string): Promise<FunctionalGateResult> {
    const result = await this.executor.runCommand(workspace, this.config.command, this.config.readOnlyMounts)
    const stderr = sanitizeText(result.stderr, MAX_SAFE_STDERR_CHARACTERS).text.trim()
    if (result.timedOut) {
      return { passed: false, phase: 'command', code: 'command_timeout', detail: stderr || 'functional command timed out' }
    }
    if (result.signal) {
      return { passed: false, phase: 'command', code: 'command_signal', detail: `${result.signal}${stderr ? `: ${stderr}` : ''}` }
    }
    if (result.exitCode !== 0) {
      return { passed: false, phase: 'command', code: 'command_exit', detail: `exit ${result.exitCode ?? 'unknown'}${stderr ? `: ${stderr}` : ''}` }
    }

    const lines = result.stdout.split('\n')
    const readyIndex = lines.findIndex((line) => line.startsWith('CCB_READY '))
    if (readyIndex < 0) {
      return { passed: false, phase: 'probe', code: 'probe_ready_missing', detail: 'functional probe omitted ready nonce' }
    }
    const nonce = lines[readyIndex]?.slice('CCB_READY '.length) ?? ''
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
      return { passed: false, phase: 'probe', code: 'probe_nonce_invalid', detail: 'functional probe returned an invalid nonce' }
    }
    const prefix = `CCB_RESULT ${nonce} `
    const encoded = lines.slice(readyIndex + 1).find((line) => line.startsWith(prefix))?.slice(prefix.length)
    if (!encoded) {
      return { passed: false, phase: 'probe', code: 'probe_result_missing', detail: 'functional probe omitted nonce-bound result' }
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return { passed: false, phase: 'probe', code: 'probe_payload_invalid', detail: 'functional probe returned invalid base64' }
    }

    let value: unknown
    try {
      value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    } catch {
      return { passed: false, phase: 'probe', code: 'probe_payload_invalid', detail: 'functional probe returned invalid JSON' }
    }
    try {
      assert.deepEqual(value, expected)
    } catch {
      return { passed: false, phase: 'assertion', code: 'assertion_mismatch', detail: 'functional result did not match the expected contract' }
    }
    return { passed: true, phase: 'assertion', code: 'passed', detail: null }
  }
}
