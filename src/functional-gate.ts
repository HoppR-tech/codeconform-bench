import assert from 'node:assert/strict'
import type { CampaignManifest, CommandResult, FunctionalGateResult, ReadOnlyMount } from './contracts.js'

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
    if (result.exitCode !== 0 || result.signal || result.timedOut) return { passed: false }

    try {
      const lines = result.stdout.split('\n')
      const readyIndex = lines.findIndex((line) => line.startsWith('CCB_READY '))
      if (readyIndex < 0) throw new Error('functional probe omitted ready nonce')
      const nonce = lines[readyIndex]?.slice('CCB_READY '.length)
      const prefix = `CCB_RESULT ${nonce} `
      const encoded = lines.slice(readyIndex + 1).find((line) => line.startsWith(prefix))?.slice(prefix.length)
      if (!encoded) throw new Error('functional probe omitted nonce-bound result')
      const value: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      assert.deepEqual(value, expected)
      return { passed: true }
    } catch {
      return { passed: false }
    }
  }
}
