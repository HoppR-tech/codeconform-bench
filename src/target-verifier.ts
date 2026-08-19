import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import type { CampaignManifest } from './contracts.js'
import { hashTree } from './digest.js'
import { runProcess } from './process.js'

export class GitTargetVerifier {
  constructor(private readonly target: CampaignManifest['target'], private readonly mounts: CampaignManifest['commandExecutor']['readOnlyMounts']) {}

  async verify(): Promise<void> {
    const commit = await runProcess('git', ['-C', this.target.checkout, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
    const tree = await runProcess('git', ['-C', this.target.checkout, 'rev-parse', 'HEAD^{tree}'], { timeoutMs: 30_000 })
    if (commit.exitCode !== 0 || commit.stdout.trim() !== this.target.commit) throw new Error('target checkout does not match manifest commit')
    if (tree.exitCode !== 0 || tree.stdout.trim() !== this.target.tree) throw new Error('target checkout does not match manifest tree')
  }

  async materialize(workspace: string): Promise<void> {
    await mkdir(workspace)
    const archive = spawn('git', ['-C', this.target.checkout, 'archive', '--format=tar', this.target.commit], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const extract = spawn('tar', ['-xf', '-', '-C', workspace], {
      env: { PATH: process.env.PATH },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    archive.stdout.pipe(extract.stdin)
    let errors = ''
    archive.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    extract.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    const timer = setTimeout(() => {
      archive.kill('SIGKILL')
      extract.kill('SIGKILL')
    }, 30_000)
    const [archiveClose, extractClose] = await Promise.all([once(archive, 'close'), once(extract, 'close')])
    clearTimeout(timer)
    if (archiveClose[0] !== 0 || extractClose[0] !== 0) throw new Error(`failed to materialize target checkout: ${errors.trim()}`)
    if (await hashTree(workspace) !== this.target.digest) throw new Error('materialized target does not match manifest digest')
    for (const mount of this.mounts) {
      if (mount.target.startsWith('/workspace/')) await mkdir(`${workspace}${mount.target.slice('/workspace'.length)}`, { recursive: true })
    }
  }
}
