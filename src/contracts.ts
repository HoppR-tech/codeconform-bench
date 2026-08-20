export type Condition = 'baseline' | 'grace'

export const QUALITY_DIMENSIONS = ['architecture', 'maintainability', 'clarity', 'tests', 'robustness'] as const
export type QualityDimension = typeof QUALITY_DIMENSIONS[number]
export type QualityDimensions = Record<QualityDimension, number>

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

export interface EvaluatorResult {
  status: 'passing' | 'failing' | 'evaluator_error'
  violations?: number
  qualityScore?: number
  qualityQualified?: boolean
  dimensions?: QualityDimensions
}

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
  functionalGateExitCode: number | null
  durationMs: number
  codeQualityScore: number | null
  qualityQualified: boolean | null
  qualityDimensions: QualityDimensions | null
  violations: number | null
}

export interface CampaignPorts {
  prepareWorkspace(workspace: string): Promise<void>
  verifyTarget(): Promise<void>
  runAgent(input: AgentInput): Promise<AgentOutput>
  runFunctionalGate(workspace: string): Promise<CommandResult>
  evaluate(workspace: string, pairId: string, condition: Condition): Promise<EvaluatorResult>
}

export interface ConditionSummary {
  total: number
  validFunctionalAttempts: number
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
