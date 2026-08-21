import { lstat, mkdir, opendir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChatFunctionTool } from '@openrouter/sdk/models'
import type { AgentCommandCode, CommandResult } from './contracts.js'
import { sanitizeText } from './safe-diagnostics.js'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_LIST_ENTRIES = 5_000
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024
const APPROVED_COMMAND_NAME = /^[a-z][a-z0-9_-]{0,63}$/

export interface CandidateCommandDiagnostic {
  command: string | null
  code: AgentCommandCode
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  reason: string | null
}

export class CandidateCommandError extends Error {
  constructor(message: string, readonly diagnostic: CandidateCommandDiagnostic) {
    super(message)
  }
}

function safeApprovedCommand(name: string): string {
  const sanitized = sanitizeText(name, 64).text
  return APPROVED_COMMAND_NAME.test(sanitized) ? sanitized : '[approved-command]'
}

function completedCommandDiagnostic(command: string, result: CommandResult): CandidateCommandDiagnostic {
  const code: AgentCommandCode = result.timedOut
    ? 'command_timeout'
    : result.signal
      ? 'command_signal'
      : result.exitCode === 0
        ? 'passed'
        : 'command_exit'
  const reason = code === 'passed'
    ? null
    : code === 'command_timeout'
      ? 'approved command timed out'
      : code === 'command_signal'
        ? 'approved command terminated by signal'
        : 'approved command exited non-zero'
  return {
    command: safeApprovedCommand(command),
    code,
    exitCode: result.exitCode,
    signal: result.signal === null ? null : sanitizeText(result.signal, 32).text,
    timedOut: result.timedOut,
    reason,
  }
}

export const candidateToolDefinitions: ChatFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List regular files under a directory in the candidate checkout.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one UTF-8 file from the candidate checkout.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace one UTF-8 file in the candidate checkout.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one pre-approved validation command by name.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
]

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function argument(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${name} must be a string`)
  return value
}

async function existingPath(root: string, requested: string): Promise<string> {
  if (isAbsolute(requested)) throw new Error('absolute paths are forbidden')
  const canonicalRoot = await realpath(root)
  const candidate = resolve(canonicalRoot, requested)
  if (!inside(canonicalRoot, candidate)) throw new Error('path escapes candidate checkout')

  let current = canonicalRoot
  for (const segment of relative(canonicalRoot, candidate).split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symbolic links are forbidden')
  }
  return candidate
}

async function writablePath(root: string, requested: string): Promise<string> {
  if (isAbsolute(requested)) throw new Error('absolute paths are forbidden')
  const canonicalRoot = await realpath(root)
  const candidate = resolve(canonicalRoot, requested)
  if (!inside(canonicalRoot, candidate) || candidate === canonicalRoot) throw new Error('path escapes candidate checkout')

  const segments = relative(canonicalRoot, candidate).split(sep).filter(Boolean)
  let current = canonicalRoot
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('write parent must be a regular directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }

  try {
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('symbolic links are forbidden')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return candidate
}

async function treeSize(root: string): Promise<number> {
  const directories = [root]
  let bytes = 0
  let entries = 0
  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    for await (const entry of await opendir(directory)) {
      entries += 1
      if (entries > MAX_LIST_ENTRIES) throw new Error('candidate contains too many entries')
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('symbolic links are forbidden')
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) bytes += (await lstat(path)).size
    }
  }
  return bytes
}

export class CandidateTools {
  private commandRuns = 0
  private readonly pendingCommandDiagnostics: CandidateCommandDiagnostic[] = []

  constructor(
    private readonly root: string,
    private readonly runApprovedCommand: (name: string) => Promise<CommandResult>,
    private readonly approvedCommandNames: ReadonlySet<string>,
  ) {}

  async execute(name: string, rawArguments: string): Promise<string> {
    const args: unknown = JSON.parse(rawArguments)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object')
    const values = args as Record<string, unknown>

    switch (name) {
      case 'list_files':
        return JSON.stringify(await this.list(argument(values.path, 'path')))
      case 'read_file':
        return this.read(argument(values.path, 'path'))
      case 'write_file':
        await this.write(argument(values.path, 'path'), argument(values.content, 'content'))
        return 'written'
      case 'run_command': {
        const command = argument(values.name, 'name')
        const approved = this.approvedCommandNames.has(command)
        if (this.commandRuns >= 1) {
          throw new CandidateCommandError('validation command limit exceeded', {
            command: approved ? safeApprovedCommand(command) : null,
            code: 'command_limit_exceeded',
            exitCode: null,
            signal: null,
            timedOut: false,
            reason: 'validation command limit exceeded',
          })
        }
        this.commandRuns += 1
        if (!approved) {
          throw new CandidateCommandError('command is not approved', {
            command: null,
            code: 'command_not_approved',
            exitCode: null,
            signal: null,
            timedOut: false,
            reason: 'requested command is not approved',
          })
        }
        let result: CommandResult
        try {
          result = await this.runApprovedCommand(command)
        } catch {
          throw new CandidateCommandError('approved command execution failed', {
            command: safeApprovedCommand(command),
            code: 'command_execution_failed',
            exitCode: null,
            signal: null,
            timedOut: false,
            reason: 'approved command execution failed',
          })
        }
        this.pendingCommandDiagnostics.push(completedCommandDiagnostic(command, result))
        return JSON.stringify(result)
      }
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  takeCommandDiagnostics(): CandidateCommandDiagnostic[] {
    return this.pendingCommandDiagnostics.splice(0)
  }

  private async list(requested: string): Promise<string[]> {
    const start = await existingPath(this.root, requested)
    if (!(await lstat(start)).isDirectory()) throw new Error('list_files path must be a directory')
    const directories = [start]
    const files: string[] = []
    let entries = 0

    while (directories.length > 0) {
      const directory = directories.pop()
      if (!directory) break
      for await (const entry of await opendir(directory)) {
        entries += 1
        if (entries > MAX_LIST_ENTRIES) throw new Error('candidate contains too many entries')
        const path = resolve(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('symbolic links are forbidden')
        if (entry.isDirectory()) directories.push(path)
        else if (entry.isFile()) files.push(relative(await realpath(this.root), path))
      }
    }
    return files.sort()
  }

  private async read(requested: string): Promise<string> {
    const path = await existingPath(this.root, requested)
    const details = await lstat(path)
    if (!details.isFile()) throw new Error('read_file path must be a regular file')
    if (details.size > MAX_FILE_BYTES) throw new Error('file exceeds read limit')
    return readFile(path, 'utf8')
  }

  private async write(requested: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content)
    if (bytes > MAX_FILE_BYTES) throw new Error('content exceeds write limit')
    const path = await writablePath(this.root, requested)
    let previousBytes = 0
    try {
      previousBytes = (await lstat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (await treeSize(this.root) - previousBytes + bytes > MAX_WORKSPACE_BYTES) throw new Error('candidate exceeds workspace size limit')
    await writeFile(path, content, { flag: 'w' })
  }
}
