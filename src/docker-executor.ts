import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { CampaignManifest, CommandResult, ReadOnlyMount } from './contracts.js'
import { hashTree } from './digest.js'
import { runProcess } from './process.js'

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000

export class DockerCommandExecutor {

  constructor(private readonly config: CampaignManifest['commandExecutor']) {}

  async verify(additionalMounts: readonly ReadOnlyMount[] = []): Promise<void> {
    for (const mount of [...this.config.readOnlyMounts, ...additionalMounts]) {
      const source = await realpath(mount.source)
      if (await hashTree(source, true) !== mount.digest) throw new Error(`read-only mount does not match manifest digest: ${mount.target}`)
    }
  }

  async runNamed(workspace: string, commandName: string): Promise<CommandResult> {
    const command = this.config.commands[commandName]
    if (!command || command.length === 0) throw new Error(`command is not approved: ${commandName}`)
    return this.runCommand(workspace, command)
  }

  async runCommand(workspace: string, command: readonly string[], additionalMounts: readonly ReadOnlyMount[] = []): Promise<CommandResult> {
    if (command.length === 0) throw new Error('command must not be empty')
    await this.verify(additionalMounts)
    const containerName = `ccb-${randomUUID()}`
    const candidate = await realpath(workspace)
    const mounts = await Promise.all([...this.config.readOnlyMounts, ...additionalMounts].map(async (mount) => ({
      source: await realpath(mount.source),
      target: mount.target,
    })))
    const mountArguments = mounts.flatMap((mount) => [
      '--mount',
      `type=bind,source=${mount.source},target=${mount.target},readonly`,
    ])

    try {
      return await runProcess('docker', [
        'run',
        '--name', containerName,
        '--rm',
        '--network', 'none',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '512',
        '--memory', '4g',
        '--cpus', '2',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=512m',
        '--mount', `type=bind,source=${candidate},target=/workspace,readonly`,
        ...mountArguments,
        '--workdir', '/workspace',
        this.config.image,
        ...command,
      ], { timeoutMs: COMMAND_TIMEOUT_MS })
    } finally {
      await runProcess('docker', ['rm', '--force', containerName], { timeoutMs: 30_000 })
    }
  }
}
