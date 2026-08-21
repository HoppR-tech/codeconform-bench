export type Condition = 'baseline' | 'grace'

export const QUALITY_DIMENSIONS = ['architecture', 'maintainability', 'clarity', 'tests', 'robustness'] as const
export type QualityDimension = typeof QUALITY_DIMENSIONS[number]
export type QualityDimensions = Record<QualityDimension, number>

export type EvidenceOperator = 'eq' | 'gte' | 'lte' | 'exists' | 'not_exists'
export type EvidenceScalar = string | number | boolean

export interface EvidenceLocation {
  path: string
  line: number
  endLine: number
  snippet: string
  message?: string
}

export interface EvidencePath {
  nodes: string[]
  totalNodes: number
  truncated: boolean
}

export interface QualityCheckEvidence {
  id: string
  dimension: QualityDimension
  title: string
  status: 'passed' | 'failed'
  mandatory: boolean
  earned: number
  max: number
  violations: number
  observed: EvidenceScalar
  operator: EvidenceOperator
  threshold: EvidenceScalar
  expected: string
  locations: EvidenceLocation[]
  locationCount: number
  locationsTruncated: boolean
  paths: EvidencePath[]
  pathCount: number
  pathsTruncated: boolean
}

export interface QualityDimensionEvidence {
  dimension: QualityDimension
  score: number
  earned: number
  max: number
  weight: number
  minimum: number
  qualified: boolean
  checks: QualityCheckEvidence[]
}

export interface QualityInventoryFile {
  path: string
  kind: 'source' | 'test'
  lines: number
  functions: number
  maxFunctionLines: number
  maxParameters: number
  maxComplexity: number
  anyTypes: number
  suppressions: number
  nonNullAssertions: number
  testCases: number
  testCasesWithAssertions: number
  assertions: number
  focusedOrSkippedTests: number
  emptyCatches: number
  dangerousCalls: number
  dangerousImports: number
}

export interface QualityEvidenceSource {
  path: string
  digest: string
  lineCount: number
  redactionCount: number
  content: string
}

export interface QualityEvidence {
  schemaVersion: 1
  overall: {
    score: number
    earned: number
    max: number
    qualifiedThreshold: number
    qualified: boolean
  }
  dimensions: QualityDimensionEvidence[]
  inventory: {
    sourceFileCount: number
    testFileCount: number
    fileCount: number
    files: QualityInventoryFile[]
    omittedUnsafePathCount: number
    filesTruncated: boolean
  }
  sources: QualityEvidenceSource[]
  structure: {
    nodes: string[]
    nodeCount: number
    nodesTruncated: boolean
    edges: { from: string, to: string }[]
    edgeCount: number
    edgesTruncated: boolean
  }
}

export interface ReadOnlyMount {
  source: string
  target: string
  digest: string
}

export interface CampaignManifest {
  schemaVersion: 2
  campaignId: string
  target: {
    checkout: string
    repository: string
    commit: string
    tree: string
    digest: string
  }
  task: {
    id: string
    prompt: string
  }
  repetitions: number
  order: readonly Condition[]
  model: {
    id: string
    providerOrder: readonly string[]
    allowFallbacks: boolean
    reasoningEffort?: 'high' | 'medium' | 'low'
    temperature?: number
    maxTokens: number
  }
  agent: {
    maxSteps: number
    maxCostUsd: number
    maxToolOutputBytes: number
    maxTotalTokens: number
  }
  commandExecutor: {
    image: string
    commands: Readonly<Record<string, readonly string[]>>
    readOnlyMounts: readonly ReadOnlyMount[]
  }
  functionalGate: {
    command: readonly string[]
    readOnlyMounts: readonly ReadOnlyMount[]
  }
  evaluator: {
    runner: {
      path: string
      digest: string
    }
    command: readonly string[]
    rulePack: {
      id: string
      version: string
      digest: string
      path: string
    }
  }
  grace: {
    mcpUrl: string
    tokenEnv: string
  }
  outputDirectory: string
  bootstrapSamples: number
  seed: number
}

export interface AgentInput {
  condition: Condition
  pairId: string
  workspace: string
  task: CampaignManifest['task']
}

export interface AgentOutput {
  status: 'completed' | 'agent_error' | 'infrastructure_error'
  error: string | null
  model: string
  provider: string | null
  promptTokens: number
  completionTokens: number
  cost: number | null
  trace: unknown[]
}

export interface CommandResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type FunctionalGatePhase = 'command' | 'probe' | 'assertion' | 'candidate_integrity'
export type FunctionalGateCode =
  | 'passed'
  | 'command_exit'
  | 'command_signal'
  | 'command_timeout'
  | 'probe_ready_missing'
  | 'probe_nonce_invalid'
  | 'probe_result_missing'
  | 'probe_payload_invalid'
  | 'assertion_mismatch'
  | 'candidate_mutated'

export interface FunctionalGateResult {
  passed: boolean
  phase: FunctionalGatePhase
  code: FunctionalGateCode
  detail: string | null
}

export const EVALUATOR_FAILURE_SCHEMA_VERSION = 1 as const
export type EvaluatorFailurePhase =
  | 'integrity'
  | 'command'
  | 'process'
  | 'result_read'
  | 'result_parse'
  | 'result_schema'
  | 'candidate_inspection'
  | 'rule_pack'
  | 'dependency_analysis'
  | 'source_analysis'
  | 'serialization'
  | 'internal'

export type EvaluatorFailureCode =
  | 'runner_digest_mismatch'
  | 'rule_pack_digest_mismatch'
  | 'command_missing'
  | 'process_timeout'
  | 'process_signal'
  | 'process_exit'
  | 'result_missing'
  | 'result_too_large'
  | 'result_invalid_json'
  | 'result_schema_invalid'
  | 'candidate_access_failed'
  | 'candidate_tree_invalid'
  | 'candidate_path_invalid'
  | 'candidate_limits_exceeded'
  | 'rule_pack_invalid'
  | 'dependency_analysis_failed'
  | 'source_analysis_failed'
  | 'serialization_failed'
  | 'internal_error'

export interface EvaluatorFailureDiagnostic {
  schemaVersion: typeof EVALUATOR_FAILURE_SCHEMA_VERSION
  phase: EvaluatorFailurePhase
  code: EvaluatorFailureCode
  reason: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  stderr?: string
  schemaPath?: string
}

export type EvaluatorResult =
  | {
    status: 'passing' | 'failing'
    violations: number
    qualityScore: number
    qualityQualified: boolean
    dimensions: QualityDimensions
    evidence: QualityEvidence
  }
  | { status: 'evaluator_error'; diagnostic: EvaluatorFailureDiagnostic }

export interface RunRecord {
  pairId: string
  condition: Condition
  status: 'scored' | 'functional_failed' | 'agent_error' | 'infrastructure_error' | 'evaluator_error'
  agentError: string | null
  targetCommit: string
  targetTree: string
  candidateDigest: string
  traceDigest: string
  model: string
  provider: string | null
  promptTokens: number
  completionTokens: number
  cost: number | null
  functionalGate: FunctionalGateResult | null
  evaluatorFailure: EvaluatorFailureDiagnostic | null
  durationMs: number
  codeQualityScore: number | null
  qualityQualified: boolean | null
  qualityDimensions: QualityDimensions | null
  violations: number | null
  qualityEvidence: QualityEvidence | null
}

export interface CampaignPorts {
  prepareWorkspace(workspace: string): Promise<void>
  verifyTarget(): Promise<void>
  runAgent(input: AgentInput): Promise<AgentOutput>
  runFunctionalGate(workspace: string): Promise<FunctionalGateResult>
  evaluate(workspace: string, pairId: string, condition: Condition): Promise<EvaluatorResult>
}

export interface ConditionSummary {
  total: number
  validFunctionalAttempts: number
  scoredAttempts: number
  validQualityAttempts: number
  functionalPasses: number
  qualityPasses: number
  functionalFailures: number
  agentErrors: number
  infrastructureErrors: number
  evaluatorErrors: number
  functionalPassAt1: number | null
  qualityPassAt1: number | null
  codeQualityMean: number | null
  dimensionMeans: QualityDimensions | null
  promptTokens: number
  completionTokens: number
  cost: number | null
  durationMeanMs: number | null
}

export interface CampaignAggregate {
  baseline: ConditionSummary
  grace: ConditionSummary
  functionalPairedAttempts: number
  qualityPairedAttempts: number
  graceFunctionalPassAt1Delta: number | null
  graceQualityPassAt1Delta: number | null
  graceCodeQualityDeltaMean: number | null
  graceCodeQualityBootstrap95: [number, number] | null
  qualityGainPerAdditional1000TokensMean: number | null
  bootstrapSamples: number
  seed: number
}

export interface CampaignResult {
  records: RunRecord[]
  aggregate: CampaignAggregate
}
