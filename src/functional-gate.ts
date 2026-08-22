import { FUNCTIONAL_EVIDENCE_SCHEMA_VERSION, type CampaignManifest, type CharacterizationSummary, type CommandResult, type FunctionalGateEvidence, type FunctionalGateResult, type FunctionalMismatch, type ReadOnlyMount } from './contracts.js'
import { MAX_SAFE_STDERR_CHARACTERS, sanitizeText } from './safe-diagnostics.js'

interface GateExecutor {
  runCommand(workspace: string, command: readonly string[], mounts: readonly ReadOnlyMount[]): Promise<CommandResult>
}

const defaultExpectedContract = {
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
  composition: {
    useCaseRegistered: true,
    infrastructureRegistered: true,
    resolverRegistered: true,
    adapterInvoked: true,
    formForwarded: true,
    userForwarded: true,
    tokenForwarded: true,
    deviceForwarded: true,
    ipForwarded: true,
    cacheUpdated: true,
    progressReturned: true,
  },
}

const MAX_PROBE_PAYLOAD_BYTES = 256 * 1024
const MAX_PROBE_JSON_NODES = 10_000
const MAX_PROBE_JSON_DEPTH = 32
const MAX_RETAINED_MISMATCHES = 16
const MAX_MISMATCH_TEXT_CHARACTERS = 160
const PROBE_LIMIT_DETAIL = 'functional probe payload exceeded diagnostic limits'
const MISSING_VALUE = Symbol('missing')

type JsonScalar = string | number | boolean | null
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

function payloadWithinLimits(value: JsonValue): boolean {
  let nodes = 0
  const visit = (current: JsonValue, depth: number): boolean => {
    nodes += 1
    if (nodes > MAX_PROBE_JSON_NODES || depth > MAX_PROBE_JSON_DEPTH) return false
    if (Array.isArray(current)) return current.every((item) => visit(item, depth + 1))
    if (current !== null && typeof current === 'object') {
      return Object.keys(current).every((key) => visit(current[key]!, depth + 1))
    }
    return true
  }
  return visit(value, 0)
}

function valueType(value: JsonValue): 'array' | 'object' | 'null' | 'string' | 'number' | 'boolean' {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function mismatchValue(value: JsonValue | typeof MISSING_VALUE): {
  text: string
  redactions: number
  truncated: boolean
} {
  if (value === MISSING_VALUE) return { text: '<missing>', redactions: 0, truncated: false }
  if (Array.isArray(value)) return { text: `<array:length=${value.length}>`, redactions: 0, truncated: false }
  if (value !== null && typeof value === 'object') return { text: '<object>', redactions: 0, truncated: false }
  const safe = sanitizeText(JSON.stringify(value), MAX_MISMATCH_TEXT_CHARACTERS)
  return { text: safe.text, redactions: safe.redactions, truncated: safe.truncated }
}

function functionalEvidence(expectedContract: JsonValue, actual: JsonValue): FunctionalGateEvidence | null {
  const mismatches: FunctionalMismatch[] = []
  let totalMismatchCount = 0
  let redactions = 0
  let valuesTruncated = 0

  const add = (
    path: string,
    kind: FunctionalMismatch['kind'],
    expectedValue: JsonValue | typeof MISSING_VALUE,
    actualValue: JsonValue | typeof MISSING_VALUE,
  ): void => {
    totalMismatchCount += 1
    if (mismatches.length >= MAX_RETAINED_MISMATCHES) return
    const expectedText = mismatchValue(expectedValue)
    const actualText = mismatchValue(actualValue)
    redactions += expectedText.redactions + actualText.redactions
    valuesTruncated += Number(expectedText.truncated) + Number(actualText.truncated)
    mismatches.push({
      path: sanitizeText(path, MAX_MISMATCH_TEXT_CHARACTERS).text,
      kind,
      expected: expectedText.text,
      actual: actualText.text,
    })
  }

  const compare = (expectedValue: JsonValue, actualValue: JsonValue, path: string): void => {
    const expectedType = valueType(expectedValue)
    const actualType = valueType(actualValue)
    if (expectedType !== actualType) {
      add(path, 'type', expectedValue, actualValue)
      return
    }
    if (Array.isArray(expectedValue) && Array.isArray(actualValue)) {
      const length = Math.max(expectedValue.length, actualValue.length)
      for (let index = 0; index < length; index += 1) {
        const childPath = `${path}/${index}`
        if (index >= expectedValue.length) add(childPath, 'unexpected', MISSING_VALUE, actualValue[index]!)
        else if (index >= actualValue.length) add(childPath, 'missing', expectedValue[index]!, MISSING_VALUE)
        else compare(expectedValue[index]!, actualValue[index]!, childPath)
      }
      return
    }
    if (
      expectedValue !== null
      && actualValue !== null
      && typeof expectedValue === 'object'
      && typeof actualValue === 'object'
    ) {
      const expectedObject = expectedValue as Record<string, JsonValue>
      const actualObject = actualValue as Record<string, JsonValue>
      const keys = [...new Set([...Object.keys(expectedObject), ...Object.keys(actualObject)])].sort()
      for (const key of keys) {
        const childPath = `${path}/${pointerSegment(key)}`
        if (!Object.hasOwn(expectedObject, key)) add(childPath, 'unexpected', MISSING_VALUE, actualObject[key]!)
        else if (!Object.hasOwn(actualObject, key)) add(childPath, 'missing', expectedObject[key]!, MISSING_VALUE)
        else compare(expectedObject[key]!, actualObject[key]!, childPath)
      }
      return
    }
    if (!Object.is(expectedValue, actualValue)) add(path, 'value', expectedValue, actualValue)
  }

  compare(expectedContract, actual, '')
  if (totalMismatchCount === 0) return null
  return {
    schemaVersion: FUNCTIONAL_EVIDENCE_SCHEMA_VERSION,
    totalMismatchCount,
    retainedMismatchCount: mismatches.length,
    truncated: totalMismatchCount > mismatches.length,
    redactions,
    valuesTruncated,
    mismatches,
  }
}
function parseNeighbors(lines: readonly string[], nonce: string): CharacterizationSummary | null {
  const marker = 'CCB_NEIGHBORS '
  const line = lines.find((candidate) => candidate.startsWith(marker))
  if (line === undefined) return null
  const separator = line.indexOf(' ', marker.length)
  const lineNonce = separator < 0 ? '' : line.slice(marker.length, separator)
  const encoded = separator < 0 ? '' : line.slice(separator + 1)
  if (lineNonce !== nonce) throw new Error('characterization payload is bound to a different nonce')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('characterization payload is not valid base64')
  }
  if (encoded.length > Math.ceil(MAX_PROBE_PAYLOAD_BYTES * 4 / 3) + 4) {
    throw new Error('characterization payload exceeded diagnostic limits')
  }
  const payload = Buffer.from(encoded, 'base64')
  if (payload.length > MAX_PROBE_PAYLOAD_BYTES) {
    throw new Error('characterization payload exceeded diagnostic limits')
  }
  let value: JsonValue
  try {
    value = JSON.parse(payload.toString('utf8')) as JsonValue
  } catch {
    throw new Error('characterization payload is not valid JSON')
  }
  if (!payloadWithinLimits(value)) {
    throw new Error('characterization payload exceeded diagnostic limits')
  }
  if (!Array.isArray(value)) throw new Error('characterization payload must be an array of neighbor results')
  let failed = 0
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('characterization entries must be objects with name and ok fields')
    }
    const record = entry as { [key: string]: JsonValue }
    if (typeof record.name !== 'string' || record.name.length === 0 || typeof record.ok !== 'boolean') {
      throw new Error('characterization entries must be objects with name and ok fields')
    }
    if (!record.ok) failed += 1
  }
  return { total: value.length, failed }
}


export class FunctionalGate {
  constructor(
    private readonly executor: GateExecutor,
    private readonly config: CampaignManifest['functionalGate'],
    private readonly expectedContract: JsonValue = config.expected ?? defaultExpectedContract,
  ) {}

  async run(workspace: string): Promise<FunctionalGateResult> {
    const result = await this.executor.runCommand(workspace, this.config.command, this.config.readOnlyMounts)
    const stderr = sanitizeText(result.stderr, MAX_SAFE_STDERR_CHARACTERS).text.trim()
    if (result.timedOut) {
      return { passed: false, phase: 'command', code: 'command_timeout', detail: stderr || 'functional command timed out', evidence: null, characterization: null }
    }
    if (result.signal) {
      return { passed: false, phase: 'command', code: 'command_signal', detail: `${result.signal}${stderr ? `: ${stderr}` : ''}`, evidence: null, characterization: null }
    }
    if (result.exitCode !== 0) {
      return { passed: false, phase: 'command', code: 'command_exit', detail: `exit ${result.exitCode ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`, evidence: null, characterization: null }
    }

    const lines = result.stdout.split('\n')
    const readyIndex = lines.findIndex((line) => line.startsWith('CCB_READY '))
    if (readyIndex < 0) {
      return { passed: false, phase: 'probe', code: 'probe_ready_missing', detail: 'functional probe omitted ready nonce', evidence: null, characterization: null }
    }
    const nonce = lines[readyIndex]?.slice('CCB_READY '.length) ?? ''
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
      return { passed: false, phase: 'probe', code: 'probe_nonce_invalid', detail: 'functional probe returned an invalid nonce', evidence: null, characterization: null }
    }
    const prefix = `CCB_RESULT ${nonce} `
    const encoded = lines.slice(readyIndex + 1).find((line) => line.startsWith(prefix))?.slice(prefix.length)
    if (!encoded) {
      return { passed: false, phase: 'probe', code: 'probe_result_missing', detail: 'functional probe omitted nonce-bound result', evidence: null, characterization: null }
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return { passed: false, phase: 'probe', code: 'probe_payload_invalid', detail: 'functional probe returned invalid base64', evidence: null, characterization: null }
    }

    if (encoded.length > Math.ceil(MAX_PROBE_PAYLOAD_BYTES * 4 / 3) + 4) {
      return { passed: false, phase: 'probe', code: 'probe_payload_limits_exceeded', detail: PROBE_LIMIT_DETAIL, evidence: null, characterization: null }
    }
    const payload = Buffer.from(encoded, 'base64')
    if (payload.length > MAX_PROBE_PAYLOAD_BYTES) {
      return { passed: false, phase: 'probe', code: 'probe_payload_limits_exceeded', detail: PROBE_LIMIT_DETAIL, evidence: null, characterization: null }
    }

    let value: JsonValue
    try {
      value = JSON.parse(payload.toString('utf8')) as JsonValue
    } catch {
      return { passed: false, phase: 'probe', code: 'probe_payload_invalid', detail: 'functional probe returned invalid JSON', evidence: null, characterization: null }
    }
    if (!payloadWithinLimits(value)) {
      return { passed: false, phase: 'probe', code: 'probe_payload_limits_exceeded', detail: PROBE_LIMIT_DETAIL, evidence: null, characterization: null }
    }
    let characterization: CharacterizationSummary | null = null
    try {
      characterization = parseNeighbors(lines, nonce)
    } catch (error) {
      return { passed: false, phase: 'probe', code: 'characterization_mismatch', detail: error instanceof Error ? error.message : 'characterization payload rejected', evidence: null, characterization: null }
    }
    const evidence = functionalEvidence(this.expectedContract, value)
    if (evidence) {
      return {
        passed: false,
        phase: 'assertion',
        code: 'assertion_mismatch',
        detail: 'functional result did not match the expected contract',
        evidence,
        characterization,
      }
    }
    return { passed: true, phase: 'assertion', code: 'passed', detail: null, evidence: null, characterization }
  }
}
