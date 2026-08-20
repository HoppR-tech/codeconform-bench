import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  QUALITY_DIMENSIONS,
  type CampaignManifest,
  type Condition,
  type EvaluatorResult,
  type EvidenceLocation,
  type EvidenceOperator,
  type EvidencePath,
  type EvidenceScalar,
  type QualityCheckEvidence,
  type QualityDimension,
  type QualityDimensionEvidence,
  type QualityDimensions,
  type QualityEvidence,
  type QualityInventoryFile,
  type QualityEvidenceSource,
} from './contracts.js'
import { sha256 } from './digest.js'
import { runProcess } from './process.js'

const EVALUATOR_TIMEOUT_MS = 2 * 60 * 1000
const MAX_RESULT_BYTES = 16 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 240
const MAX_SNIPPET_CHARACTERS = 180
const MAX_PATH_CHARACTERS = 120
const MAX_CHECK_ID_CHARACTERS = 80
const MAX_SCALAR_TEXT_CHARACTERS = 80
const MAX_CANONICAL_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_LOCATIONS = 6
const MAX_PATHS = 6
const MAX_PATH_NODES = 10_000
const MAX_EVIDENCE_V1_CHECKS_PER_DIMENSION = 35
const MAX_EVIDENCE_V1_TOTAL_CHECKS = 35
const MAX_CANDIDATE_ENTRIES = 10_000
const MAX_GRAPH_ENTRIES = 200_000
const CHECK_ID = /^[a-z][a-z0-9.-]+$/
const OPERATORS: Record<EvidenceOperator, true> = { eq: true, gte: true, lte: true, exists: true, not_exists: true }
const URL_CREDENTIAL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  return value as Record<string, unknown>
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('expected bounded array')
  return value
}

function text(value: unknown, maximum = MAX_TEXT_CHARACTERS): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) throw new Error('expected bounded text')
  return value
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('expected boolean')
  return value
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new Error('expected bounded integer')
  return value as number
}

function finite(value: unknown, minimum = 0, maximum = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error('expected bounded number')
  }
  return value
}

function scalar(value: unknown): EvidenceScalar {
  if (typeof value === 'number') return finite(value, -Number.MAX_VALUE, Number.MAX_VALUE)
  if (typeof value === 'boolean') return value
  return text(value, MAX_SCALAR_TEXT_CHARACTERS)
}
function candidatePath(value: unknown): string {
  const path = text(value, MAX_PATH_CHARACTERS)
  const normalized = path.normalize('NFC')
  if (
    path.length === 0
    || path !== normalized
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || /[\u0000-\u001f\u007f]/.test(path)
  ) throw new Error('expected normalized candidate-relative path')
  return path
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right))
}

function location(value: unknown): EvidenceLocation {
  const raw = object(value)
  const line = integer(raw.line, Number.MAX_SAFE_INTEGER)
  const endLine = integer(raw.endLine, Number.MAX_SAFE_INTEGER)
  if (line < 1 || endLine < line) throw new Error('invalid source range')
  const message = raw.message === undefined ? undefined : text(raw.message)
  const snippet = text(raw.snippet, MAX_SNIPPET_CHARACTERS)
  if (URL_CREDENTIAL.test(snippet)) throw new Error('source snippet contains unredacted URL credentials')
  return {
    path: candidatePath(raw.path),
    line,
    endLine,
    snippet,
    ...(message === undefined ? {} : { message }),
  }
}

function evidencePath(value: unknown): EvidencePath {
  const raw = object(value)
  const nodes = list(raw.nodes, MAX_PATH_NODES).map(candidatePath)
  const totalNodes = integer(raw.totalNodes, MAX_CANDIDATE_ENTRIES)
  const truncated = bool(raw.truncated)
  if (totalNodes !== nodes.length || truncated) throw new Error('canonical dependency path must be complete')
  return { nodes, totalNodes, truncated }
}

function operatorPasses(operator: EvidenceOperator, observed: EvidenceScalar, threshold: EvidenceScalar): boolean {
  switch (operator) {
    case 'eq': return observed === threshold
    case 'gte': return typeof observed === 'number' && typeof threshold === 'number' && observed >= threshold
    case 'lte': return typeof observed === 'number' && typeof threshold === 'number' && observed <= threshold
    case 'exists': return observed === true && threshold === true
    case 'not_exists': return observed === false && threshold === false
  }
}

function qualityCheck(value: unknown, dimension: QualityDimension): QualityCheckEvidence {
  const raw = object(value)
  const id = text(raw.id, MAX_CHECK_ID_CHARACTERS)
  const title = text(raw.title)
  const status = text(raw.status)
  const operator = text(raw.operator) as EvidenceOperator
  const observed = scalar(raw.observed)
  const threshold = scalar(raw.threshold)
  const maximum = finite(raw.max, Number.MIN_VALUE)
  const earned = finite(raw.earned, 0, maximum)
  const locations = list(raw.locations, MAX_LOCATIONS).map(location)
  const locationCount = integer(raw.locationCount, MAX_CANDIDATE_ENTRIES)
  const locationsTruncated = bool(raw.locationsTruncated)
  const paths = list(raw.paths, MAX_PATHS).map(evidencePath)
  const pathCount = integer(raw.pathCount, MAX_CANDIDATE_ENTRIES)
  const pathsTruncated = bool(raw.pathsTruncated)
  if (
    !CHECK_ID.test(id)
    || raw.dimension !== dimension
    || (status !== 'passed' && status !== 'failed')
    || !(operator in OPERATORS)
    || status !== (operatorPasses(operator, observed, threshold) ? 'passed' : 'failed')
    || !approximatelyEqual(earned, status === 'passed' ? maximum : 0)
    || locationCount < locations.length
    || locationsTruncated !== (locationCount > locations.length)
    || pathCount < paths.length
    || pathsTruncated !== (pathCount > paths.length)
  ) throw new Error('invalid check evidence')
  return {
    id,
    dimension,
    title,
    status,
    mandatory: bool(raw.mandatory),
    earned,
    max: maximum,
    violations: integer(raw.violations, MAX_CANDIDATE_ENTRIES),
    observed,
    operator,
    threshold,
    expected: text(raw.expected),
    locations,
    locationCount,
    locationsTruncated,
    paths,
    pathCount,
    pathsTruncated,
  }
}

function dimensionEvidence(value: unknown, dimension: QualityDimension, ids: Set<string>): QualityDimensionEvidence {
  const raw = object(value)
  if (raw.dimension !== dimension) throw new Error('dimension evidence is out of order')
  const checks = list(raw.checks, MAX_EVIDENCE_V1_CHECKS_PER_DIMENSION).map((check) => qualityCheck(check, dimension))
  if (checks.length === 0) throw new Error('dimension must contain checks')
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error('duplicate check id')
    ids.add(check.id)
  }
  const earned = finite(raw.earned)
  const maximum = finite(raw.max, Number.MIN_VALUE)
  const score = finite(raw.score, 0, 1)
  const minimum = finite(raw.minimum, 0, 1)
  const recomputedEarned = checks.reduce((total, check) => total + check.earned, 0)
  const recomputedMaximum = checks.reduce((total, check) => total + check.max, 0)
  const qualified = score >= minimum && checks.every((check) => !check.mandatory || check.status === 'passed')
  if (
    !approximatelyEqual(earned, recomputedEarned)
    || !approximatelyEqual(maximum, recomputedMaximum)
    || !approximatelyEqual(score, earned / maximum)
    || raw.qualified !== qualified
  ) throw new Error('dimension score does not reconcile')
  return {
    dimension,
    score,
    earned,
    max: maximum,
    weight: finite(raw.weight, Number.MIN_VALUE),
    minimum,
    qualified,
    checks,
  }
}

function inventoryFile(value: unknown): QualityInventoryFile {
  const raw = object(value)
  const kind = text(raw.kind)
  if (kind !== 'source' && kind !== 'test') throw new Error('invalid inventory kind')
  return {
    path: candidatePath(raw.path),
    kind,
    lines: integer(raw.lines, MAX_CANDIDATE_ENTRIES),
    functions: integer(raw.functions, MAX_CANDIDATE_ENTRIES),
    maxFunctionLines: integer(raw.maxFunctionLines, MAX_CANDIDATE_ENTRIES),
    maxParameters: integer(raw.maxParameters, MAX_CANDIDATE_ENTRIES),
    maxComplexity: integer(raw.maxComplexity, MAX_CANDIDATE_ENTRIES),
    anyTypes: integer(raw.anyTypes, MAX_CANDIDATE_ENTRIES),
    suppressions: integer(raw.suppressions, MAX_CANDIDATE_ENTRIES),
    nonNullAssertions: integer(raw.nonNullAssertions, MAX_CANDIDATE_ENTRIES),
    testCases: integer(raw.testCases, MAX_CANDIDATE_ENTRIES),
    testCasesWithAssertions: integer(raw.testCasesWithAssertions, MAX_CANDIDATE_ENTRIES),
    assertions: integer(raw.assertions, MAX_CANDIDATE_ENTRIES),
    focusedOrSkippedTests: integer(raw.focusedOrSkippedTests, MAX_CANDIDATE_ENTRIES),
    emptyCatches: integer(raw.emptyCatches, MAX_CANDIDATE_ENTRIES),
    dangerousCalls: integer(raw.dangerousCalls, MAX_CANDIDATE_ENTRIES),
    dangerousImports: integer(raw.dangerousImports, MAX_CANDIDATE_ENTRIES),
  }
}

function sourceEvidence(value: unknown): QualityEvidenceSource {
  const raw = object(value)
  const content = text(raw.content, MAX_CANONICAL_SOURCE_BYTES)
  const digest = text(raw.digest)
  if (URL_CREDENTIAL.test(content)) throw new Error('canonical source contains unredacted URL credentials')
  const lineCount = integer(raw.lineCount, MAX_CANDIDATE_ENTRIES)
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || lineCount !== content.split('\n').length) {
    throw new Error('invalid canonical source evidence')
  }
  return {
    path: candidatePath(raw.path),
    digest,
    lineCount,
    redactionCount: integer(raw.redactionCount, MAX_CANDIDATE_ENTRIES),
    content,
  }
}

function evidence(value: unknown, scores: QualityDimensions, qualityScore: number, qualityQualified: boolean, violations: number): QualityEvidence {
  const raw = object(value)
  if (raw.schemaVersion !== 1) throw new Error('unsupported evidence schema')
  const ids = new Set<string>()
  const rawDimensions = list(raw.dimensions, QUALITY_DIMENSIONS.length)
  if (rawDimensions.length !== QUALITY_DIMENSIONS.length) throw new Error('missing dimension evidence')
  const dimensions = QUALITY_DIMENSIONS.map((dimension, index) => dimensionEvidence(rawDimensions[index], dimension, ids))
  if (dimensions.reduce((total, dimension) => total + dimension.checks.length, 0) > MAX_EVIDENCE_V1_TOTAL_CHECKS) {
    throw new Error('evidence schema v1 exceeds its total check budget')
  }
  for (const dimension of dimensions) {
    if (!approximatelyEqual(dimension.score, scores[dimension.dimension])) throw new Error('public dimension score mismatch')
  }

  const rawOverall = object(raw.overall)
  const overallMaximum = finite(rawOverall.max, Number.MIN_VALUE)
  const overallEarned = finite(rawOverall.earned)
  const overallScore = finite(rawOverall.score, 0, 1)
  const qualifiedThreshold = finite(rawOverall.qualifiedThreshold, 0, 1)
  const recomputedMaximum = dimensions.reduce((total, dimension) => total + dimension.weight, 0)
  const recomputedEarned = dimensions.reduce((total, dimension) => total + dimension.score * dimension.weight, 0)
  const qualified = overallScore >= qualifiedThreshold && dimensions.every((dimension) => dimension.qualified)
  const recomputedViolations = dimensions.reduce(
    (total, dimension) => total + dimension.checks.reduce((sum, check) => sum + check.violations, 0),
    0,
  )
  if (
    !approximatelyEqual(overallMaximum, recomputedMaximum)
    || !approximatelyEqual(overallEarned, recomputedEarned)
    || !approximatelyEqual(overallScore, overallEarned / overallMaximum)
    || !approximatelyEqual(overallScore, qualityScore)
    || rawOverall.qualified !== qualified
    || qualified !== qualityQualified
    || recomputedViolations !== violations
  ) throw new Error('overall evidence does not reconcile')

  const rawInventory = object(raw.inventory)
  const files = list(rawInventory.files, MAX_CANDIDATE_ENTRIES).map(inventoryFile)
  const sourceFileCount = integer(rawInventory.sourceFileCount, MAX_CANDIDATE_ENTRIES)
  const testFileCount = integer(rawInventory.testFileCount, MAX_CANDIDATE_ENTRIES)
  const fileCount = integer(rawInventory.fileCount, MAX_CANDIDATE_ENTRIES)
  const omittedUnsafePathCount = integer(rawInventory.omittedUnsafePathCount, MAX_CANDIDATE_ENTRIES)
  const filesTruncated = bool(rawInventory.filesTruncated)
  const filePaths = files.map((file) => file.path)
  if (
    fileCount !== sourceFileCount + testFileCount
    || files.length !== fileCount
    || omittedUnsafePathCount !== 0
    || filesTruncated
    || new Set(filePaths).size !== filePaths.length
  ) throw new Error('canonical evidence inventory must be complete')

  const sources = list(raw.sources, MAX_CANDIDATE_ENTRIES).map(sourceEvidence)
  const sourcePaths = sources.map((source) => source.path)
  if (
    sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.content), 0) > MAX_CANONICAL_SOURCE_BYTES
    || new Set(sourcePaths).size !== sourcePaths.length
    || sourcePaths.some((path, index) => path !== filePaths[index] || sources[index]?.lineCount !== files[index]?.lines)
  ) throw new Error('canonical scored-source evidence must be complete')

  const rawStructure = object(raw.structure)
  const nodes = list(rawStructure.nodes, MAX_GRAPH_ENTRIES).map(candidatePath)
  const nodeCount = integer(rawStructure.nodeCount, MAX_GRAPH_ENTRIES)
  const nodesTruncated = bool(rawStructure.nodesTruncated)
  const edges = list(rawStructure.edges, MAX_GRAPH_ENTRIES).map((value) => {
    const edge = object(value)
    return { from: candidatePath(edge.from), to: candidatePath(edge.to) }
  })
  const edgeCount = integer(rawStructure.edgeCount, MAX_GRAPH_ENTRIES)
  const edgesTruncated = bool(rawStructure.edgesTruncated)
  const nodeSet = new Set(nodes)
  if (
    new Set(nodes).size !== nodes.length
    || nodes.some((path, index) => index > 0 && path <= (nodes[index - 1] ?? ''))
    || nodeCount !== nodes.length
    || nodesTruncated
    || edges.some((edge) => !nodeSet.has(edge.from) || !nodeSet.has(edge.to))
    || edgeCount !== edges.length
    || edgesTruncated
  ) throw new Error('canonical dependency structure must be complete')

  return {
    schemaVersion: 1,
    overall: {
      score: overallScore,
      earned: overallEarned,
      max: overallMaximum,
      qualifiedThreshold,
      qualified,
    },
    dimensions,
    inventory: {
      sourceFileCount,
      testFileCount,
      fileCount,
      files,
      omittedUnsafePathCount,
      filesTruncated,
    },
    sources,
    structure: {
      nodes,
      nodeCount,
      nodesTruncated,
      edges,
      edgeCount,
      edgesTruncated,
    },
  }
}

function qualityDimensions(value: unknown): QualityDimensions {
  const raw = object(value)
  return Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [
    dimension,
    finite(raw[dimension], 0, 1),
  ])) as QualityDimensions
}

export class ProcessEvaluator {
  constructor(
    private readonly config: CampaignManifest['evaluator'],
    private readonly outputDirectory: string,
  ) {}

  async evaluate(workspace: string, pairId: string, condition: Condition): Promise<EvaluatorResult> {
    if (
      sha256(await readFile(this.config.rulePack.path)) !== this.config.rulePack.digest
      || sha256(await readFile(this.config.runner.path)) !== this.config.runner.digest
    ) {
      return { status: 'evaluator_error' }
    }

    const directory = resolve(this.outputDirectory, 'evaluator')
    await mkdir(directory, { recursive: true })
    const resultPath = resolve(directory, `${pairId}-${condition}.json`)
    await rm(resultPath, { force: true })
    const command = this.config.command.map((part) => part
      .replaceAll('{candidate}', workspace)
      .replaceAll('{result}', resultPath)
      .replaceAll('{rulePack}', this.config.rulePack.path)
      .replaceAll('{runner}', this.config.runner.path))
    const executable = command[0]
    if (!executable) return { status: 'evaluator_error' }

    const processResult = await runProcess(executable, command.slice(1), { timeoutMs: EVALUATOR_TIMEOUT_MS })
    if (processResult.exitCode !== 0 || processResult.signal || processResult.timedOut) return { status: 'evaluator_error' }

    try {
      if ((await stat(resultPath)).size > MAX_RESULT_BYTES) return { status: 'evaluator_error' }
      const raw: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
      const result = object(raw)
      if (result.status === 'evaluator_error') return { status: 'evaluator_error' }
      if (result.status !== 'passing' && result.status !== 'failing') return { status: 'evaluator_error' }
      const violations = integer(result.violations, MAX_CANDIDATE_ENTRIES)
      const qualityScore = finite(result.qualityScore, 0, 1)
      const qualityQualified = bool(result.qualityQualified)
      if ((result.status === 'passing') !== qualityQualified) return { status: 'evaluator_error' }
      const dimensions = qualityDimensions(result.dimensions)
      return {
        status: result.status,
        violations,
        qualityScore,
        qualityQualified,
        dimensions,
        evidence: evidence(result.evidence, dimensions, qualityScore, qualityQualified, violations),
      }
    } catch {
      return { status: 'evaluator_error' }
    }
  }
}
