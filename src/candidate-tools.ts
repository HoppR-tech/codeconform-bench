import { lstat, mkdir, opendir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChatFunctionTool } from '@openrouter/sdk/models'
import type { AgentCommandCode, CommandResult } from './contracts.js'
import { sanitizeText } from './safe-diagnostics.js'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_LIST_ENTRIES = 5_000
const MAX_GREP_MATCHES = 200
const TRUNCATION_SENTINEL = '\u0000truncated'
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
      description: 'Read one UTF-8 file from the candidate checkout, optionally a 1-based line window.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: ['integer', 'null'], description: 'First line to return, 1-based.' },
          limit: { type: ['integer', 'null'], description: 'Maximum number of lines to return.' },
        },
        required: ['path', 'offset', 'limit'],
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
      name: 'edit',
      description: 'Replace an exact substring in one UTF-8 file of the candidate checkout.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: ['boolean', 'null'], description: 'Replace every occurrence instead of failing on multiples.' },
        },
        required: ['path', 'old_string', 'new_string', 'replace_all'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a JavaScript regular expression and return relpath:line:text matches.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: ['string', 'null'], description: 'File or directory to search; defaults to the checkout root.' },
          include: { type: ['string', 'null'], description: 'Glob filtering which files are searched, e.g. *.ts.' },
        },
        required: ['pattern', 'path', 'include'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'List files whose checkout-relative path matches a glob pattern.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          glob: { type: 'string' },
          path: { type: ['string', 'null'], description: 'Directory to search; defaults to the checkout root.' },
        },
        required: ['glob', 'path'],
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

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return argument(value, name)
}

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value as number
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? ''
    if (character === '*') {
      if (glob[index + 1] === '*') {
        while (glob[index + 1] === '*') index += 1
        pattern += '.*'
      } else {
        pattern += '[^/]*'
      }
    } else if (character === '?') {
      pattern += '[^/]'
    } else {
      pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
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
    private readonly maxCommandCalls = 1,
  ) {}

  async execute(name: string, rawArguments: string): Promise<string> {
    const args: unknown = JSON.parse(rawArguments)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object')
    const values = args as Record<string, unknown>

    switch (name) {
      case 'list_files':
        return JSON.stringify(await this.list(argument(values.path, 'path')))
      case 'read_file': {
        const offset = optionalInteger(values.offset, 'offset', 1)
        const limit = optionalInteger(values.limit, 'limit', 1)
        return this.read(argument(values.path, 'path'), offset, limit)
      }
      case 'write_file':
        await this.write(argument(values.path, 'path'), argument(values.content, 'content'))
        return 'written'
      case 'edit':
        return this.edit(
          argument(values.path, 'path'),
          argument(values.old_string, 'old_string'),
          argument(values.new_string, 'new_string'),
          optionalBoolean(values.replace_all, 'replace_all') ?? false,
        )
      case 'grep':
        return this.grep(
          argument(values.pattern, 'pattern'),
          optionalString(values.path, 'path'),
          optionalString(values.include, 'include'),
        )
      case 'find_files':
        return this.findFiles(argument(values.glob, 'glob'), optionalString(values.path, 'path'))
      case 'run_command': {
        const command = argument(values.name, 'name')
        const approved = this.approvedCommandNames.has(command)
        if (this.commandRuns >= this.maxCommandCalls) {
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

  private async read(requested: string, offset?: number, limit?: number): Promise<string> {
    const path = await existingPath(this.root, requested)
    const details = await lstat(path)
    if (!details.isFile()) throw new Error('read_file path must be a regular file')
    if (details.size > MAX_FILE_BYTES) throw new Error('file exceeds read limit')
    const content = await readFile(path, 'utf8')
    if (offset === undefined && limit === undefined) return content
    const lines = content.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const start = (offset ?? 1) - 1
    if (start >= lines.length) throw new Error('read_file offset is beyond end of file')
    const window = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
    let output = window.join('\n')
    if (start + window.length < lines.length) output += `\n… ${lines.length - start - window.length} more lines`
    return output
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

  private async *walk(directory: string): AsyncGenerator<string> {
    const directories = [directory]
    let entries = 0
    while (directories.length > 0) {
      const current = directories.pop()
      if (!current) break
      for await (const entry of await opendir(current)) {
        entries += 1
        if (entries > MAX_LIST_ENTRIES) {
          yield TRUNCATION_SENTINEL
          return
        }
        const path = resolve(current, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) directories.push(path)
        else if (entry.isFile()) yield relative(directory, path).split(sep).join('/')
      }
    }
  }

  private async edit(requested: string, oldString: string, newString: string, replaceAll: boolean): Promise<string> {
    if (Buffer.byteLength(oldString) > MAX_FILE_BYTES) throw new Error('old_string exceeds edit limit')
    if (Buffer.byteLength(newString) > MAX_FILE_BYTES) throw new Error('new_string exceeds edit limit')
    const path = await writablePath(this.root, requested)
    let details
    try {
      details = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('edit target does not exist')
      throw error
    }
    if (!details.isFile()) throw new Error('edit path must be a regular file')
    if (details.size > MAX_FILE_BYTES) throw new Error('file exceeds edit limit')
    const content = await readFile(path, 'utf8')
    const occurrences = content.split(oldString).length - 1
    if (occurrences === 0) throw new Error('old_string not found')
    if (occurrences > 1 && !replaceAll) throw new Error(`old_string matches ${occurrences} locations`)
    const updated = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    if (await treeSize(this.root) - details.size + Buffer.byteLength(updated) > MAX_WORKSPACE_BYTES) throw new Error('candidate exceeds workspace size limit')
    await writeFile(path, updated, { flag: 'w' })
    return 'edited'
  }

  private async grep(pattern: string, requested: string | undefined, include: string | undefined): Promise<string> {
    let matcher: RegExp
    try {
      matcher = new RegExp(pattern)
    } catch {
      throw new Error('invalid grep pattern')
    }
    const includeMatcher = include === undefined ? null : globToRegExp(include)
    const canonicalRoot = await realpath(this.root)
    const start = await existingPath(this.root, requested ?? '.')
    const details = await lstat(start)
    if (!details.isFile() && !details.isDirectory()) throw new Error('grep path must be a regular file or directory')
    const results: string[] = []
    let truncated = false
    const consider = async (absolute: string): Promise<void> => {
      const rel = relative(canonicalRoot, absolute).split(sep).join('/')
      if (includeMatcher !== null && !includeMatcher.test(rel)) return
      const stats = await lstat(absolute)
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return
      const content = await readFile(absolute, 'utf8')
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        if (!matcher.test(line)) continue
        if (results.length >= MAX_GREP_MATCHES) {
          truncated = true
          return
        }
        results.push(`${rel}:${index + 1}:${line}`)
      }
    }
    if (details.isFile()) await consider(start)
    else {
      for await (const rel of this.walk(start)) {
        if (truncated) break
        if (rel === TRUNCATION_SENTINEL) {
          truncated = true
          break
        }
        await consider(resolve(start, rel))
      }
    }
    if (truncated) results.push('… results truncated')
    return results.join('\n')
  }

  private async findFiles(pattern: string, requested: string | undefined): Promise<string> {
    const matcher = globToRegExp(pattern)
    const start = await existingPath(this.root, requested ?? '.')
    if (!(await lstat(start)).isDirectory()) throw new Error('find_files path must be a directory')
    const matches: string[] = []
    let truncated = false
    for await (const rel of this.walk(start)) {
      if (rel === TRUNCATION_SENTINEL) {
        truncated = true
        break
      }
      if (!matcher.test(rel)) continue
      if (matches.length >= MAX_LIST_ENTRIES) {
        truncated = true
        break
      }
      matches.push(rel)
    }
    matches.sort()
    if (truncated) matches.push('… truncated')
    return matches.join('\n')
  }
}
