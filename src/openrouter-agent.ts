import { OpenRouter } from '@openrouter/sdk'
import type { ChatMessages } from '@openrouter/sdk/models'
import { candidateToolDefinitions, CandidateTools } from './candidate-tools.js'
import type { GraceTools } from './grace-mcp.js'
import type { AgentInput, AgentOutput, CampaignManifest } from './contracts.js'

const SYSTEM_PROMPT = `You are editing one candidate repository for an architecture benchmark.
Use only the declared tools. Do not request web access, external repositories, hidden tests, evaluator rules, credentials, or paths outside the candidate checkout.
Inspect before writing, make the smallest complete change, run the approved validation command, then finish with a concise summary.`
const PROMPT_TOKEN_OVERHEAD = 1_024
const COST_SCALE = 1_000_000_000_000

export class OpenRouterAgent {
  private readonly client: OpenRouter

  constructor(
    apiKey: string,
    private readonly model: CampaignManifest['model'],
    private readonly limits: CampaignManifest['agent'],
  ) {
    this.client = new OpenRouter({
      apiKey,
      appTitle: 'CodeConform-Bench',
      httpReferer: 'https://github.com/HoppR-tech/codeconform-bench',
      timeoutMs: 10 * 60 * 1000,
    })
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
    let agentError: string | null = null

    try {
      for (let step = 0; step < this.limits.maxSteps; step += 1) {
        const remainingTokens = this.limits.maxTotalTokens - promptTokens - completionTokens
        const promptTokenReservation = Buffer.byteLength(JSON.stringify({ messages, tools: toolDefinitions })) + PROMPT_TOKEN_OVERHEAD
        const maxTokens = Math.min(this.model.maxTokens, remainingTokens - promptTokenReservation)
        if (maxTokens < 1) throw new Error('agent token budget exhausted before request')
        const response = await this.client.chat.send({
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
        })
        if (!('choices' in response)) throw new Error('OpenRouter unexpectedly returned a streaming response')
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
        ) throw new Error('OpenRouter response omitted or returned invalid token or cost usage')
        promptTokens += response.usage.promptTokens
        completionTokens += response.usage.completionTokens
        cost = Math.round((cost + response.usage.cost) * COST_SCALE) / COST_SCALE
        hasCost = true
        if (promptTokens + completionTokens > this.limits.maxTotalTokens) throw new Error('agent token budget exceeded')
        if (cost > this.limits.maxCostUsd) throw new Error('agent cost budget exceeded')
        const choice = response.choices[0]
        if (!choice) throw new Error('OpenRouter returned no completion choice')
        provider = response.openrouterMetadata?.endpoints.available.find((endpoint) => endpoint.selected)?.provider ?? provider
        messages.push(choice.message)

        const calls = choice.message.toolCalls ?? []
        if (calls.length === 0) {
          return {
            status: 'completed',
            error: null,
            model: response.model,
            provider,
            promptTokens,
            completionTokens,
            cost: hasCost ? cost : null,
            trace: messages,
          }
        }

        for (const call of calls) {
          let content: string
          try {
            content = graceToolNames.has(call.function.name)
              ? await graceTools!.execute(call.function.name, call.function.arguments)
              : await tools.execute(call.function.name, call.function.arguments)
          } catch (error) {
            content = JSON.stringify({ error: error instanceof Error ? error.message : 'tool failed' })
          }
          toolOutputBytes += Buffer.byteLength(content)
          if (toolOutputBytes > this.limits.maxToolOutputBytes) throw new Error('agent tool-output budget exceeded')
          messages.push({ role: 'tool', toolCallId: call.id, content })
        }
      }
    } catch (error) {
      agentError = error instanceof Error ? error.message : 'unknown error'
      messages.push({ role: 'system', content: `Harness error: ${agentError}` })
    }

    return {
      status: 'agent_error',
      error: agentError,
      model: this.model.id,
      provider,
      promptTokens,
      completionTokens,
      cost: hasCost ? cost : null,
      trace: messages,
    }
  }
}
