export type Condition = 'baseline' | 'grace'

export interface ReadOnlyMount {
  source: string
  target: string
  digest: string
}

export interface CampaignManifest {
  schemaVersion: 1
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
  status: 'completed' | 'agent_error'
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
  score?: number
  weightedScore?: number
}

export interface RunRecord {
  pairId: string
  condition: Condition
  status: 'scored' | 'functional_failed' | 'agent_error' | 'evaluator_error'
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
  architectureScore: number | null
  weightedArchitectureScore: number | null
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
  scored: number
  functionalFailures: number
  agentErrors: number
  evaluatorErrors: number
  functionalFailureRate: number | null
  architectureMedian: number | null
  weightedArchitectureMedian: number | null
  promptTokens: number
  completionTokens: number
  cost: number | null
  durationMedianMs: number | null
}

export interface CampaignAggregate {
  baseline: ConditionSummary
  grace: ConditionSummary
  completeScoredPairs: number
  graceDeltaMedian: number | null
  graceDeltaBootstrap95: [number, number] | null
  qualityGainPerAdditional1000TokensMedian: number | null
  bootstrapSamples: number
  seed: number
}

export interface CampaignResult {
  records: RunRecord[]
  aggregate: CampaignAggregate
}
