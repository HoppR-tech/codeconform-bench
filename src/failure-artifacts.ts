import { opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { sha256 } from './digest.js'
import { isSensitiveCandidatePath, sanitizeText } from './safe-diagnostics.js'
import type { CandidateRecoveryInput, CandidateRecoveryMetadata } from './contracts.js'

const MAX_TREE_ENTRIES = 10_000
const MAX_RECOVERY_OPERATIONS = 512
const MAX_RECOVERY_FILE_BYTES = 256 * 1024
const MAX_RECOVERY_CONTENT_BYTES = 2 * 1024 * 1024
const MAX_RECOVERY_PATH_CHARACTERS = 240

interface TreeFile {
  absolutePath: string
  size: number
}

interface RecoveryOperation {
  operation: 'write' | 'delete'
  path: string
  content?: string
  originalDigest?: string
  recoveredDigest?: string
  redactions?: number
}

interface OmittedOperation {
  path: string
  reason: 'sensitive_path' | 'binary' | 'file_too_large' | 'archive_too_large' | 'operation_limit'
}

function safeRelativePath(root: string, path: string): string | null {
  const candidate = relative(root, path).replaceAll('\\', '/').normalize('NFC')
  if (
    candidate.length === 0
    || candidate.length > MAX_RECOVERY_PATH_CHARACTERS
    || candidate.startsWith('/')
    || candidate.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) return null
  return candidate
}

async function collectFiles(root: string): Promise<{ files: Map<string, TreeFile>; omittedUnsafePathCount: number }> {
  const files = new Map<string, TreeFile>()
  const directories = [root]
  let entries = 0
  let omittedUnsafePathCount = 0
  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) break
    for await (const entry of await opendir(directory)) {
      if (entry.name === '.git') continue
      entries += 1
      if (entries > MAX_TREE_ENTRIES) throw new Error('candidate recovery tree exceeds entry limit')
      const absolutePath = resolve(directory, entry.name)
      const path = safeRelativePath(root, absolutePath)
      if (!path) {
        omittedUnsafePathCount += 1
        continue
      }
      if (entry.isDirectory()) directories.push(absolutePath)
      else if (entry.isFile()) files.set(path, { absolutePath, size: (await stat(absolutePath)).size })
      else throw new Error('candidate recovery tree contains a non-regular entry')
    }
  }
  return { files, omittedUnsafePathCount }
}

async function changed(base: TreeFile | undefined, candidate: TreeFile): Promise<{ content: Buffer; digest: string } | null> {
  const content = await readFile(candidate.absolutePath)
  const digest = sha256(content)
  if (!base || base.size !== candidate.size) return { content, digest }
  return sha256(await readFile(base.absolutePath)) === digest ? null : { content, digest }
}

export async function writeCandidateRecoveryArtifact(
  options: CandidateRecoveryInput,
): Promise<CandidateRecoveryMetadata> {
  const [base, candidate] = await Promise.all([
    collectFiles(options.baseRoot),
    collectFiles(options.candidateRoot),
  ])
  const baseFiles = base.files
  const candidateFiles = candidate.files
  const omittedUnsafePathCount = base.omittedUnsafePathCount + candidate.omittedUnsafePathCount
  const operations: RecoveryOperation[] = []
  const omitted: OmittedOperation[] = []
  let contentBytes = 0
  let redactions = 0
  const paths = [...new Set([...baseFiles.keys(), ...candidateFiles.keys()])].sort()

  for (const path of paths) {
    const base = baseFiles.get(path)
    const candidate = candidateFiles.get(path)
    if (!candidate) {
      if (operations.length >= MAX_RECOVERY_OPERATIONS) omitted.push({ path, reason: 'operation_limit' })
      else operations.push({ operation: 'delete', path })
      continue
    }
    const difference = await changed(base, candidate)
    if (!difference) continue
    if (isSensitiveCandidatePath(path)) {
      omitted.push({ path, reason: 'sensitive_path' })
      continue
    }
    if (operations.length >= MAX_RECOVERY_OPERATIONS) {
      omitted.push({ path, reason: 'operation_limit' })
      continue
    }
    if (difference.content.length > MAX_RECOVERY_FILE_BYTES) {
      omitted.push({ path, reason: 'file_too_large' })
      continue
    }
    const decoded = difference.content.toString('utf8')
    if (!Buffer.from(decoded, 'utf8').equals(difference.content)) {
      omitted.push({ path, reason: 'binary' })
      continue
    }
    const safe = sanitizeText(decoded, MAX_RECOVERY_FILE_BYTES)
    const bytes = Buffer.byteLength(safe.text)
    if (safe.truncated || contentBytes + bytes > MAX_RECOVERY_CONTENT_BYTES) {
      omitted.push({ path, reason: safe.truncated ? 'file_too_large' : 'archive_too_large' })
      continue
    }
    contentBytes += bytes
    redactions += safe.redactions
    operations.push({
      operation: 'write',
      path,
      content: safe.text,
      originalDigest: difference.digest,
      recoveredDigest: sha256(safe.text),
      redactions: safe.redactions,
    })
  }

  await writeFile(options.outputPath, `${JSON.stringify({
    schemaVersion: 1,
    base: { commit: options.baseCommit, tree: options.baseTree },
    candidateDigest: options.candidateDigest,
    complete: omitted.length === 0 && redactions === 0 && omittedUnsafePathCount === 0,
    redactions,
    omittedUnsafePathCount,
    limits: {
      maximumOperations: MAX_RECOVERY_OPERATIONS,
      maximumFileBytes: MAX_RECOVERY_FILE_BYTES,
      maximumContentBytes: MAX_RECOVERY_CONTENT_BYTES,
    },
    operations,
    omitted,
  }, null, 2)}\n`)
  return {
    complete: omitted.length === 0 && redactions === 0 && omittedUnsafePathCount === 0,
    redactions,
    omittedUnsafePathCount,
    operationCount: operations.length,
    omittedCount: omitted.length,
  }
}
