import { spawn } from 'node:child_process'
import type { CommandResult } from './contracts.js'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export async function runProcess(executable: string, args: readonly string[], options: {
  cwd?: string
  timeoutMs: number
}): Promise<CommandResult> {
  const { promise, resolve } = Promise.withResolvers<CommandResult>()
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let outputExceeded = false
    let timedOut = false
    let settled = false

    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill('SIGKILL')
        return
      }
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }

    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
    child.on('error', (error) => finish({ exitCode: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut }))
    child.on('close', (exitCode, signal) => finish({
      exitCode: outputExceeded ? null : exitCode,
      signal,
      stdout,
      stderr: outputExceeded ? `${stderr}\nprocess output exceeded ${MAX_OUTPUT_BYTES} bytes` : stderr,
      timedOut,
    }))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
  }, options.timeoutMs)
  return promise
}
