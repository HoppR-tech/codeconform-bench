import { OpenRouter } from '@openrouter/sdk'
import { ConnectionError, RequestTimeoutError } from '@openrouter/sdk/models/errors'
import type { ChatMessages } from '@openrouter/sdk/models'
import { CandidateCommandError, candidateToolDefinitions, CandidateTools, type CandidateCommandDiagnostic } from './candidate-tools.js'
import { GraceToolInputError, type GraceTools } from './grace-mcp.js'
import { COMMAND_DIAGNOSTIC_SCHEMA_VERSION, AGENT_DIAGNOSTIC_SCHEMA_VERSION, type AgentCommandDiagnostic, type AgentExecutionSummary, type AgentFailureCode, type AgentInput, type AgentOutput, type AgentToolActivity, type AgentToolUsage, type CampaignManifest } from './contracts.js'
import { safeReason, sanitizeText } from './safe-diagnostics.js'

const SYSTEM_PROMPT = `You are editing one candidate repository for a code-quality benchmark.
Use only the declared tools. Do not request web access, external repositories, hidden tests, evaluator rules, credentials, or paths outside the candidate checkout.
Inspect before writing, make the smallest complete change, run the approved validation commands as needed, then finish with a concise summary.`
const PROMPT_TOKEN_OVERHEAD = 1_024
const COST_SCALE = 1_000_000_000_000
const MAX_REQUEST_RETRIES = 3
const MAX_RETRY_ELAPSED_MS = 120_000
const SDK_REQUEST_OPTIONS = { retries: { strategy: 'none' as const } }
const MAX_TOOL_USAGE_ENTRIES = 64
const MAX_RECENT_TOOL_CALLS = 8
const MAX_COMMAND_DIAGNOSTICS = 4
const UNKNOWN_TOOL_NAME = '[unknown-tool]'
const CLOSURE_NOTICES = new Map<number, string>([
  [20, 'Harness notice: 20 model steps remain. Stop broad exploration; complete the smallest correct change, run the approved validation command if it has not run, then finish with a concise response without tool calls.'],
  [5, 'Harness notice: 5 model steps remain. Do not start new work; finish the current edit or validation and return a concise response without tool calls.'],
])
const waitFor = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}
class AgentFailureError extends Error {
  constructor(
    readonly code: AgentFailureCode,
    readonly status: 'agent_error' | 'infrastructure_error',
    message: string,
  ) {
    super(message)
  }
}

class AgentLimitError extends AgentFailureError {
  constructor(code: Extract<AgentFailureCode,
    | 'token_budget_exhausted'
    | 'token_budget_exceeded'
    | 'cost_budget_exceeded'
    | 'tool_output_budget_exceeded'
    | 'wall_clock_exceeded'
  >, message: string) {
    super(code, 'agent_error', message)
  }
}

function normalizeToolName(
  name: string,
  candidateToolNames: ReadonlySet<string>,
  graceToolNames: ReadonlySet<string>,
): string {
  if (candidateToolNames.has(name)) return name
  if (!graceToolNames.has(name)) return UNKNOWN_TOOL_NAME
  const sanitized = sanitizeText(name, 64).text
  return /^[a-z][a-z0-9_]{0,63}$/.test(sanitized) ? sanitized : UNKNOWN_TOOL_NAME
}

function executionSummary(
  limits: CampaignManifest['agent'],
  counters: {
    stepsUsed: number
    requestAttempts: number
    toolCalls: number
    toolUsage: Map<string, AgentToolUsage>
    toolUsageTruncated: boolean
    recentToolCalls: AgentToolActivity[]
    commandDiagnostics: AgentCommandDiagnostic[]
    commandDiagnosticsTruncated: boolean
  },
  failure: AgentFailureError | null,
): AgentExecutionSummary {
  return {
    stepsUsed: counters.stepsUsed,
    maxSteps: limits.maxSteps,
    requestAttempts: counters.requestAttempts,
    toolCalls: counters.toolCalls,
    toolUsage: [...counters.toolUsage.values()].sort((left, right) => left.name.localeCompare(right.name)),
    toolUsageTruncated: counters.toolUsageTruncated,
    recentToolCalls: counters.recentToolCalls,
    commandDiagnostics: counters.commandDiagnostics,
    commandDiagnosticsTruncated: counters.commandDiagnosticsTruncated,
    failure: failure === null
      ? null
      : {
        schemaVersion: AGENT_DIAGNOSTIC_SCHEMA_VERSION,
        code: failure.code,
        reason: safeReason(failure, 'agent execution failed'),
      },
  }
}

interface HttpResponseError extends Error {
  statusCode: number
  headers: { get(name: string): string | null }
}

function isRetryableResponseError(error: unknown): error is HttpResponseError {
  return error instanceof Error
    && typeof (error as Partial<HttpResponseError>).statusCode === 'number'
    && typeof (error as Partial<HttpResponseError>).headers?.get === 'function'
    && ((error as HttpResponseError).statusCode === 408
      || (error as HttpResponseError).statusCode === 429
      || (error as HttpResponseError).statusCode >= 500)
}

function retryAfterMilliseconds(error: HttpResponseError): number | null {
  const retryAfterMilliseconds = error.headers.get('retry-after-ms')?.trim()
  if (retryAfterMilliseconds) {
    const milliseconds = Number(retryAfterMilliseconds)
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds
  }

  const retryAfter = error.headers.get('retry-after')?.trim()
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

export class OpenRouterAgent {
  private readonly client: OpenRouter

  constructor(
    apiKey: string,
    private readonly model: CampaignManifest['model'],
    private readonly limits: CampaignManifest['agent'],
    private readonly wait: (milliseconds: number) => Promise<void> = waitFor,
    private readonly now: () => number = Date.now,
  ) {
    this.client = new OpenRouter({
      apiKey,
      appTitle: 'CodeConform-Bench',
      httpReferer: 'https://github.com/HoppR-tech/codeconform-bench',
      timeoutMs: 10 * 60 * 1000,
    })
  }

  private async sendWithRetries<T>(send: (timeoutMs?: number) => Promise<T>): Promise<T> {
    const startedAt = this.now()
    let retries = 0
    while (true) {
      const elapsed = Math.max(0, this.now() - startedAt)
      const timeoutMs = retries === 0 ? undefined : Math.max(1, MAX_RETRY_ELAPSED_MS - elapsed)
      try {
        return await send(timeoutMs)
      } catch (error) {
        const responseError = isRetryableResponseError(error)
        const connectionError = error instanceof ConnectionError || error instanceof RequestTimeoutError
        const remaining = MAX_RETRY_ELAPSED_MS - Math.max(0, this.now() - startedAt)
        if ((!responseError && !connectionError) || retries >= MAX_REQUEST_RETRIES || remaining <= 0) throw error
        const delay = responseError
          ? retryAfterMilliseconds(error)
            ?? (error.statusCode === 429 ? 60_000 : 1_000 * (2 ** retries))
          : 1_000 * (2 ** retries)
        if (delay >= remaining) throw error
        await this.wait(delay)
        if (this.now() - startedAt >= MAX_RETRY_ELAPSED_MS) throw error
        retries += 1
      }
    }
  }

  async run(input: AgentInput, tools: CandidateTools, grace?: GraceTools): Promise<AgentOutput> {
    const graceTools = input.condition === 'grace' ? grace : undefined
    if (input.condition === 'grace' && !graceTools) throw new Error('Grace condition requires an MCP connection')
    const candidateToolNames = new Set(candidateToolDefinitions.flatMap((tool) => 'function' in tool ? [tool.function.name] : []))
    const collision = graceTools?.definitions.find((tool) => candidateToolNames.has(tool.function.name))
    if (collision) throw new Error(`Grace MCP tool conflicts with candidate tool: ${collision.function.name}`)
    const toolDefinitions = [...candidateToolDefinitions, ...(graceTools?.definitions ?? [])]
    const graceToolNames = new Set(graceTools?.definitions.map((tool) => tool.function.name) ?? [])
    const messages: ChatMessages[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(graceTools?.instructions ? [{ role: 'system' as const, content: `Grace MCP instructions:\n${graceTools.instructions}` }] : []),
      { role: 'user', content: input.task.prompt },
    ]

    let promptTokens = 0
    let completionTokens = 0
    let cost = 0
    let hasCost = false
    let provider: string | null = null
    let toolOutputBytes = 0
    let model = this.model.id
    let failure: AgentFailureError | null = null
    const counters = {
      stepsUsed: 0,
      requestAttempts: 0,
      toolCalls: 0,
      toolUsage: new Map<string, AgentToolUsage>(),
      toolUsageTruncated: false,
      recentToolCalls: [] as AgentToolActivity[],
      commandDiagnostics: [] as AgentCommandDiagnostic[],
      commandDiagnosticsTruncated: false,
    }
    const recordToolActivity = (activity: AgentToolActivity): void => {
      counters.toolCalls += 1
      const existing = counters.toolUsage.get(activity.name)
      if (existing) {
        existing.count += 1
        if (activity.outcome !== 'ok') existing.errorCount += 1
      } else if (counters.toolUsage.size < MAX_TOOL_USAGE_ENTRIES) {
        counters.toolUsage.set(activity.name, {
          name: activity.name,
          count: 1,
          errorCount: activity.outcome === 'ok' ? 0 : 1,
        })
      } else {
        counters.toolUsageTruncated = true
      }
      counters.recentToolCalls.push(activity)
      if (counters.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) counters.recentToolCalls.shift()
    }
    const recordCommandDiagnostic = (step: number, diagnostic: CandidateCommandDiagnostic): void => {
      if (counters.commandDiagnostics.length >= MAX_COMMAND_DIAGNOSTICS) {
        counters.commandDiagnosticsTruncated = true
        return
      }
      counters.commandDiagnostics.push({
        schemaVersion: COMMAND_DIAGNOSTIC_SCHEMA_VERSION,
        step,
        ...diagnostic,
      })
    }

    try {
      const deadlineAt = this.limits.wallClockSeconds === undefined ? null : this.now() + this.limits.wallClockSeconds * 1_000
      const assertWallClock = (): void => {
        if (deadlineAt !== null && this.now() >= deadlineAt) {
          throw new AgentLimitError('wall_clock_exceeded', 'agent wall-clock budget exhausted')
        }
      }
      for (let step = 1; step <= this.limits.maxSteps; step += 1) {
        assertWallClock()
        const notice = CLOSURE_NOTICES.get(this.limits.maxSteps - step + 1)
        if (notice) messages.push({ role: 'system', content: notice })
        const remainingTokens = this.limits.maxTotalTokens - promptTokens - completionTokens
        const promptTokenReservation = Buffer.byteLength(JSON.stringify({ messages, tools: toolDefinitions })) + PROMPT_TOKEN_OVERHEAD
        const maxTokens = Math.min(this.model.maxTokens, remainingTokens - promptTokenReservation)
        if (maxTokens < 1) {
          throw new AgentLimitError('token_budget_exhausted', 'agent token budget exhausted before request')
        }

        counters.stepsUsed += 1
        assertWallClock()
        let response
        try {
          response = await this.sendWithRetries((timeoutMs) => {
            counters.requestAttempts += 1
            return this.client.chat.send({
              chatRequest: {
                stream: false,
                model: this.model.id,
                messages,
                maxTokens,
                tools: toolDefinitions,
                toolChoice: 'auto',
                provider: {
                  order: [...this.model.providerOrder],
                  allowFallbacks: this.model.allowFallbacks,
                  requireParameters: true,
                },
                ...(this.model.reasoningEffort ? { reasoningEffort: this.model.reasoningEffort } : {}),
                ...(this.model.temperature === undefined ? {} : { temperature: this.model.temperature }),
              },
            }, { ...SDK_REQUEST_OPTIONS, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
          })
        } catch (error) {
          throw new AgentFailureError(
            'provider_transport_failed',
            'infrastructure_error',
            safeReason(error, 'OpenRouter request failed'),
          )
        }
        if (!('choices' in response)) {
          throw new AgentFailureError(
            'provider_response_invalid',
            'infrastructure_error',
            'OpenRouter unexpectedly returned a streaming response',
          )
        }
        if (
          !response.usage
          || typeof response.usage.promptTokens !== 'number'
          || typeof response.usage.completionTokens !== 'number'
          || typeof response.usage.cost !== 'number'
          || !Number.isFinite(response.usage.promptTokens)
          || !Number.isFinite(response.usage.completionTokens)
          || !Number.isFinite(response.usage.cost)
          || response.usage.promptTokens < 0
          || response.usage.completionTokens < 0
          || response.usage.cost < 0
        ) {
          throw new AgentFailureError(
            'provider_response_invalid',
            'infrastructure_error',
            'OpenRouter response omitted or returned invalid token or cost usage',
          )
        }
        promptTokens += response.usage.promptTokens
        completionTokens += response.usage.completionTokens
        cost = Math.round((cost + response.usage.cost) * COST_SCALE) / COST_SCALE
        hasCost = true
        model = response.model
        if (promptTokens + completionTokens > this.limits.maxTotalTokens) {
          throw new AgentLimitError('token_budget_exceeded', 'agent token budget exceeded')
        }
        if (cost > this.limits.maxCostUsd) {
          throw new AgentLimitError('cost_budget_exceeded', 'agent cost budget exceeded')
        }
        const choice = response.choices[0]
        if (!choice) {
          throw new AgentFailureError(
            'provider_response_invalid',
            'infrastructure_error',
            'OpenRouter returned no completion choice',
          )
        }
        provider = response.openrouterMetadata?.endpoints.available.find((endpoint) => endpoint.selected)?.provider ?? provider
        messages.push(choice.message)

        const calls = choice.message.toolCalls ?? []
        if (calls.length === 0) {
          return {
            status: 'completed',
            execution: executionSummary(this.limits, counters, null),
            model,
            provider,
            promptTokens,
            completionTokens,
            cost: hasCost ? cost : null,
            trace: messages,
          }
        }

        for (const call of calls) {
          const name = normalizeToolName(call.function.name, candidateToolNames, graceToolNames)
          let content: string
          if (graceToolNames.has(call.function.name)) {
            try {
              content = await graceTools!.execute(call.function.name, call.function.arguments)
              recordToolActivity({ step, name, outcome: 'ok' })
            } catch (error) {
              if (error instanceof GraceToolInputError) {
                recordToolActivity({ step, name, outcome: 'input_error' })
                content = JSON.stringify({ error: error.message })
              } else {
                recordToolActivity({ step, name, outcome: 'execution_error' })
                throw new AgentFailureError(
                  'grace_transport_failed',
                  'infrastructure_error',
                  safeReason(error, 'Grace MCP request failed'),
                )
              }
            }
          } else {
            try {
              content = await tools.execute(call.function.name, call.function.arguments)
              if (typeof tools.takeCommandDiagnostics === 'function') {
                for (const diagnostic of tools.takeCommandDiagnostics()) recordCommandDiagnostic(step, diagnostic)
              }
              recordToolActivity({ step, name, outcome: 'ok' })
            } catch (error) {
              if (error instanceof CandidateCommandError) recordCommandDiagnostic(step, error.diagnostic)
              recordToolActivity({ step, name, outcome: 'execution_error' })
              content = JSON.stringify({ error: error instanceof Error ? error.message : 'tool failed' })
            }
          }
          toolOutputBytes += Buffer.byteLength(content)
          if (toolOutputBytes > this.limits.maxToolOutputBytes) {
            throw new AgentLimitError('tool_output_budget_exceeded', 'agent tool-output budget exceeded')
          }
          messages.push({ role: 'tool', toolCallId: call.id, content })
        }
      }
      failure = new AgentFailureError('step_budget_exhausted', 'agent_error', 'agent step budget exhausted')
    } catch (error) {
      failure = error instanceof AgentFailureError
        ? error
        : new AgentFailureError('agent_execution_failed', 'infrastructure_error', safeReason(error, 'agent execution failed'))
    }

    messages.push({ role: 'system', content: `Harness error: ${safeReason(failure, 'agent execution failed')}` })
    return {
      status: failure.status,
      execution: executionSummary(this.limits, counters, failure),
      model,
      provider,
      promptTokens,
      completionTokens,
      cost: hasCost ? cost : null,
      trace: messages,
    }
  }
}
