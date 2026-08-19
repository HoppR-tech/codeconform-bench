import { OpenRouter } from '@openrouter/sdk'
import type { ChatMessages } from '@openrouter/sdk/models'
import { candidateToolDefinitions, CandidateTools } from './candidate-tools.js'
import type { AgentInput, AgentOutput, CampaignManifest } from './contracts.js'

const SYSTEM_PROMPT = `You are editing one candidate repository for an architecture benchmark.
Use only the declared tools. Do not request web access, external repositories, hidden tests, evaluator rules, credentials, or paths outside the candidate checkout.
Inspect before writing, make the smallest complete change, run the approved validation command, then finish with a concise summary.`
const PROMPT_TOKEN_OVERHEAD = 1_024

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

  async run(input: AgentInput, tools: CandidateTools): Promise<AgentOutput> {
    const messages: ChatMessages[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${input.task.prompt}\n\nArchitecture intent shared by both conditions:\n${input.task.architectureIntent}`,
      },
    ]
    if (input.graceContext) messages.splice(1, 0, { role: 'system', content: `Grace guidance:\n${input.graceContext}` })

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
        const promptTokenReservation = Buffer.byteLength(JSON.stringify({ messages, tools: candidateToolDefinitions })) + PROMPT_TOKEN_OVERHEAD
        const maxTokens = Math.min(this.model.maxTokens, remainingTokens - promptTokenReservation)
        if (maxTokens < 1) throw new Error('agent token budget exhausted before request')
        const response = await this.client.chat.send({
          chatRequest: {
            stream: false,
            model: this.model.id,
            messages,
            maxTokens,
            tools: candidateToolDefinitions,
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
        const choice = response.choices[0]
        if (!choice) throw new Error('OpenRouter returned no completion choice')
        if (!response.usage || typeof response.usage.promptTokens !== 'number' || typeof response.usage.completionTokens !== 'number') throw new Error('OpenRouter response omitted token usage')
        promptTokens += response.usage.promptTokens
        completionTokens += response.usage.completionTokens
        if (response.usage?.cost != null) {
          cost += response.usage.cost
          hasCost = true
        }
        provider = response.openrouterMetadata?.endpoints.available.find((endpoint) => endpoint.selected)?.provider ?? provider
        messages.push(choice.message)
        if (promptTokens + completionTokens > this.limits.maxTotalTokens) throw new Error('agent token budget exceeded')

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
            content = await tools.execute(call.function.name, call.function.arguments)
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
