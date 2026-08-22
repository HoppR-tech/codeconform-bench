import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectionError, RequestTimeoutError } from '@openrouter/sdk/models/errors'
import { CandidateTools } from '../src/candidate-tools.js'
import { GraceToolInputError, type GraceTools } from '../src/grace-mcp.js'
import { OpenRouterAgent } from '../src/openrouter-agent.js'

test('stops before feeding oversized tool output back to the model', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 100_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 16 })
  let requests = 0
  let requestedMaxTokens = 0
  let requestMessages: unknown[] = []
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async (request: { chatRequest: { maxTokens: number; messages: unknown[] } }) => {
        requests += 1
        requestedMaxTokens = request.chatRequest.maxTokens
        requestMessages = request.chatRequest.messages
        return {
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"large"}' } }] } }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const tools = { execute: async () => 'x'.repeat(17) } as unknown as CandidateTools

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, tools)

  assert.equal(result.status, 'agent_error')
  assert.equal(result.execution.failure?.reason, 'agent tool-output budget exceeded')
  assert.equal(result.execution.failure?.code, 'tool_output_budget_exceeded')
  assert.deepEqual(result.execution.toolUsage, [{ name: 'read_file', count: 1, errorCount: 0 }])
  assert.deepEqual(result.execution.recentToolCalls, [{ step: 1, name: 'read_file', outcome: 'ok' }])
  assert.equal(requests, 1)
  assert.ok(requestedMaxTokens > 0 && requestedMaxTokens < 10_000)
  assert.deepEqual(requestMessages[1], { role: 'user', content: 'Refactor.' })
  assert.match(JSON.stringify(result.trace), /agent tool-output budget exceeded/)
})

test('classifies Grace transport failures as infrastructure errors', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'grace_quality', arguments: '{}' } }] } }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const grace = {
    definitions: [{ type: 'function', function: { name: 'grace_quality', parameters: { type: 'object' } } }],
    execute: async () => { throw new Error('MCP disconnected') },
  } as unknown as GraceTools

  const result = await agent.run({
    condition: 'grace',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools, grace)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.reason, 'MCP disconnected')
  assert.equal(result.execution.failure?.code, 'grace_transport_failed')
  assert.deepEqual(result.execution.recentToolCalls, [{ step: 1, name: 'grace_quality', outcome: 'execution_error' }])
  assert.equal(requests, 1)
})

test('returns invalid Grace tool arguments to the model', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{ message: requests === 1
            ? { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'grace_quality', arguments: 'invalid' } }] }
            : { role: 'assistant', content: 'done' } }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const grace = {
    definitions: [{ type: 'function', function: { name: 'grace_quality', parameters: { type: 'object' } } }],
    execute: async () => { throw new GraceToolInputError('Grace MCP tool arguments must be valid JSON') },
  } as unknown as GraceTools

  const result = await agent.run({
    condition: 'grace',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools, grace)

  assert.equal(result.status, 'completed')
  assert.equal(requests, 2)
  assert.match(JSON.stringify(result.trace), /must be valid JSON/)
  assert.equal(result.execution.failure, null)
  assert.deepEqual(result.execution.toolUsage, [{ name: 'grace_quality', count: 1, errorCount: 1 }])
  assert.deepEqual(result.execution.recentToolCalls, [{ step: 1, name: 'grace_quality', outcome: 'input_error' }])
})

test('retries transient responses and honors Retry-After within one global budget', async () => {
  const waits: number[] = []
  let now = 0
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 }, async (milliseconds) => {
    waits.push(milliseconds)
    now += milliseconds
  }, () => now)
  let requests = 0
  let requestOptions: unknown
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async (_request: unknown, options: unknown) => {
        requests += 1
        requestOptions = options
        if (requests === 1) throw new ConnectionError('connection failed')
        if (requests === 2) {
          throw Object.assign(new Error('provider unavailable'), { statusCode: 503, headers: new Headers() })
        }
        if (requests === 3) {
          throw Object.assign(new Error('rate limited'), { statusCode: 429, headers: new Headers({ 'retry-after': '2' }) })
        }
        return {
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'completed')
  assert.equal(requests, 4)
  assert.deepEqual(waits, [1_000, 2_000, 2_000])
  assert.equal(result.execution.stepsUsed, 1)
  assert.equal(result.execution.requestAttempts, 4)
  assert.deepEqual(requestOptions, { retries: { strategy: 'none' }, timeoutMs: 115_000 })
})

test('does not retry when Retry-After consumes its entire wait budget', async () => {
  const waits: number[] = []
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 }, async (milliseconds) => {
    waits.push(milliseconds)
  })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        throw Object.assign(new Error('rate limited'), { statusCode: 429, headers: new Headers({ 'retry-after': '120' }) })
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.code, 'provider_transport_failed')
  assert.equal(result.execution.stepsUsed, 1)
  assert.equal(result.execution.requestAttempts, 1)
  assert.equal(result.execution.failure?.reason, 'rate limited')
  assert.equal(requests, 1)
  assert.deepEqual(waits, [])
})

test('uses the rate-limit fallback for an empty Retry-After header', async () => {
  const waits: number[] = []
  let now = 0
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 }, async (milliseconds) => {
    waits.push(milliseconds)
    now += milliseconds
  }, () => now)
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        if (requests === 1) {
          throw Object.assign(new Error('rate limited'), { statusCode: 429, headers: new Headers({ 'retry-after': ' ' }) })
        }
        return {
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'completed')
  assert.equal(requests, 2)
  assert.deepEqual(waits, [60_000])
})

test('does not retry when a timer resumes after the retry deadline', async () => {
  let now = 0
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 }, async () => {
    now = 120_001
  }, () => now)
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        throw Object.assign(new Error('provider unavailable'), { statusCode: 503, headers: new Headers() })
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.reason, 'provider unavailable')
  assert.equal(requests, 1)
})

test('does not retry after a request consumes the retry window', async () => {
  const waits: number[] = []
  let now = 0
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 }, async (milliseconds) => {
    waits.push(milliseconds)
  }, () => now)
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        now = 120_001
        throw new RequestTimeoutError('request timed out')
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.reason, 'request timed out')
  assert.equal(requests, 1)
  assert.deepEqual(waits, [])
})

test('allows the ceiling and stops after cumulative response cost exceeds it', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 4, maxCostUsd: 0.3, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  let requests = 0
  let toolCalls = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: requests < 3
              ? { role: 'assistant', content: null, toolCalls: [{ id: `call-${requests}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture"}' } }] }
              : { role: 'assistant', content: 'done' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: [0.1, 0.2, 0.01][requests - 1] },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => { toolCalls += 1; return '' } } as unknown as CandidateTools)

  assert.equal(result.status, 'agent_error')
  assert.equal(result.execution.failure?.reason, 'agent cost budget exceeded')
  assert.equal(result.execution.failure?.code, 'cost_budget_exceeded')
  assert.equal(result.cost, 0.31)
  assert.equal(requests, 3)
  assert.equal(toolCalls, 2)
})

test('retains charged usage when OpenRouter returns no completion choice', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => ({
        model: 'fixture-model',
        choices: [],
        usage: { promptTokens: 10, completionTokens: 0, cost: 0.25 },
      }),
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.reason, 'OpenRouter returned no completion choice')
  assert.equal(result.execution.failure?.code, 'provider_response_invalid')
  assert.equal(result.cost, 0.25)
})

test('fails closed when OpenRouter omits response cost', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => ({
        model: 'fixture-model',
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'infrastructure_error')
  assert.match(result.execution.failure?.reason ?? '', /invalid token or cost usage/)
  assert.equal(result.execution.failure?.code, 'provider_response_invalid')
})

test('reports exhaustion of the agent step budget', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [{ id: `call-${requests}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture"}' } }],
            },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(requests, 2)
  assert.equal(result.status, 'agent_error')
  assert.equal(result.execution.failure?.reason, 'agent step budget exhausted')
  assert.equal(result.execution.failure?.code, 'step_budget_exhausted')
  assert.equal(result.execution.stepsUsed, 2)
  assert.equal(result.execution.requestAttempts, 2)
  assert.equal(result.execution.toolCalls, 2)
  assert.match(JSON.stringify(result.trace), /agent step budget exhausted/)
})


test('exposes Grace MCP instructions and tools only to the Grace condition', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 3, maxCostUsd: 30, maxTotalTokens: 30_000, maxToolOutputBytes: 1_024 })
  const requests: Array<{ messages: unknown[]; tools: Array<{ function: { name: string } }> }> = []
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async (request: { chatRequest: { messages: unknown[]; tools: Array<{ function: { name: string } }> } }) => {
        requests.push(request.chatRequest)
        const graceFirstStep = requests.length === 2
        return {
          model: 'fixture-model',
          choices: [{
            message: graceFirstStep
              ? { role: 'assistant', content: null, toolCalls: [{ id: 'call-grace', type: 'function', function: { name: 'grace_prepare_task', arguments: '{"talentIds":["grace.architecture.use-case"]}' } }] }
              : { role: 'assistant', content: 'done' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const localTools = { execute: async () => { throw new Error('local tool should not run') } } as unknown as CandidateTools
  const graceCalls: string[] = []
  const grace: GraceTools = {
    definitions: [{
      type: 'function',
      function: {
        name: 'grace_prepare_task',
        description: 'Prepare Grace guidance.',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    }],
    instructions: 'Call Grace before editing.',
    execute: async (name, input) => {
      graceCalls.push(`${name}:${input}`)
      return '{\"resolutionId\":\"fixture\"}'
    },
    close: async () => {},
  }

  const baseline = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, localTools, grace)
  const guided = await agent.run({
    condition: 'grace',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, localTools, grace)

  assert.equal(baseline.status, 'completed')
  assert.equal(guided.status, 'completed')
  assert.equal(requests[0]?.tools.some((tool) => tool.function.name === 'grace_prepare_task'), false)
  assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /Grace MCP/)
  assert.equal(requests[1]?.tools.some((tool) => tool.function.name === 'grace_prepare_task'), true)
  assert.match(JSON.stringify(requests[1]?.messages), /Call Grace before editing/)
  assert.deepEqual(graceCalls, ['grace_prepare_task:{\"talentIds\":[\"grace.architecture.use-case\"]}'])
  await assert.rejects(() => agent.run({
    condition: 'grace',
    pairId: 'pair-02',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, localTools, {
    ...grace,
    definitions: [{
      type: 'function',
      function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
    }],
  }), /conflicts with candidate tool: read_file/)
})

test('injects each closure notice once and does not force a final no-tool turn', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 21, maxCostUsd: 30, maxTotalTokens: 1_000_000, maxToolOutputBytes: 10_000 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [{ id: `call-${requests}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
            },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  const systemMessages = result.trace
    .filter((message): message is { role: string, content: string } => (
      typeof message === 'object'
      && message !== null
      && 'role' in message
      && message.role === 'system'
      && 'content' in message
      && typeof message.content === 'string'
    ))
    .map((message) => message.content)
  assert.equal(systemMessages.filter((message) => message.startsWith('Harness notice: 20 model steps remain.')).length, 1)
  assert.equal(systemMessages.filter((message) => message.startsWith('Harness notice: 5 model steps remain.')).length, 1)
  assert.equal(result.execution.failure?.code, 'step_budget_exhausted')
  assert.equal(result.execution.stepsUsed, 21)
  assert.equal(result.execution.requestAttempts, 21)
})

test('omits closure notices after natural termination', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 120, maxCostUsd: 30, maxTotalTokens: 100_000, maxToolOutputBytes: 1_024 })
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => ({
        model: 'fixture-model',
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
      }),
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.failure, null)
  assert.doesNotMatch(JSON.stringify(result.trace), /Harness notice:/)
})

test('bounds and sorts tool telemetry across multiple calls per step', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 4, maxCostUsd: 30, maxTotalTokens: 100_000, maxToolOutputBytes: 10_000 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: requests === 4
              ? { role: 'assistant', content: 'done' }
              : {
                role: 'assistant',
                content: null,
                toolCalls: [
                  { id: `${requests}-a`, type: 'function', function: { name: 'write_file', arguments: '{}' } },
                  { id: `${requests}-b`, type: 'function', function: { name: 'mystery_tool', arguments: '{}' } },
                  { id: `${requests}-c`, type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
              },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, {
    execute: async (name: string) => {
      if (name === 'mystery_tool') throw new Error('unknown')
      return ''
    },
  } as unknown as CandidateTools)

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.toolCalls, 9)
  assert.deepEqual(result.execution.toolUsage.map(({ name }) => name), ['[unknown-tool]', 'read_file', 'write_file'])
  assert.deepEqual(result.execution.toolUsage.find(({ name }) => name === '[unknown-tool]'), {
    name: '[unknown-tool]',
    count: 3,
    errorCount: 3,
  })
  assert.equal(result.execution.recentToolCalls.length, 8)
  assert.deepEqual(result.execution.recentToolCalls[0], { step: 1, name: '[unknown-tool]', outcome: 'execution_error' })
  assert.deepEqual(result.execution.recentToolCalls.at(-1), { step: 3, name: 'read_file', outcome: 'ok' })
})

test('redacts generic failures and rejects unsafe registered Grace tool names from telemetry', async () => {
  const unsafeNames = ['Grace-Bad-token="definitely-secret-value"', 'a'.repeat(65)]
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 100_000, maxToolOutputBytes: 1_024 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        if (requests === 1) {
          return {
            model: 'fixture-model',
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                toolCalls: unsafeNames.map((name, index) => ({
                  id: `call-${index}`,
                  type: 'function',
                  function: { name, arguments: '{}' },
                })),
              },
            }],
            usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
          }
        }
        const message = { role: 'assistant', content: 'done' }
        Object.defineProperty(message, 'toolCalls', {
          get: () => { throw new Error(`token="definitely-secret-value" /Users/alex/private ${'x'.repeat(300)}`) },
        })
        return {
          model: 'fixture-model',
          choices: [{ message }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const grace = {
    definitions: unsafeNames.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    execute: async () => '',
  } as unknown as GraceTools

  const result = await agent.run({
    condition: 'grace',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools, grace)

  assert.equal(result.status, 'infrastructure_error')
  assert.equal(result.execution.failure?.code, 'agent_execution_failed')
  assert.ok((result.execution.failure?.reason.length ?? 0) <= 240)
  assert.doesNotMatch(result.execution.failure?.reason ?? '', /definitely-secret-value|\/Users\/alex/)
  assert.deepEqual(result.execution.toolUsage, [{ name: '[unknown-tool]', count: 2, errorCount: 0 }])
})

test('distinguishes token reservation exhaustion from post-response overage', async () => {
  const exhausted = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 1, maxToolOutputBytes: 1_024 })
  const unreachableClient = { chat: { send: async () => { throw new Error('must not request') } } }
  Object.defineProperty(exhausted, 'client', { value: unreachableClient })
  const input = {
    condition: 'baseline' as const,
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }
  const tools = { execute: async () => '' } as unknown as CandidateTools
  const exhaustedResult = await exhausted.run(input, tools)
  assert.equal(exhaustedResult.execution.failure?.code, 'token_budget_exhausted')
  assert.equal(exhaustedResult.execution.stepsUsed, 0)
  assert.equal(exhaustedResult.execution.requestAttempts, 0)

  const exceeded = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 1, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024 })
  Object.defineProperty(exceeded, 'client', { value: {
    chat: {
      send: async () => ({
        model: 'fixture-model',
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { promptTokens: 9_999, completionTokens: 2, cost: 0.01 },
      }),
    },
  } })
  const exceededResult = await exceeded.run(input, tools)
  assert.equal(exceededResult.execution.failure?.code, 'token_budget_exceeded')
  assert.equal(exceededResult.execution.stepsUsed, 1)
  assert.equal(exceededResult.execution.requestAttempts, 1)
})

test('caps tool usage aggregates at sixty-four registered names', async () => {
  const names = Array.from({ length: 65 }, (_, index) => `grace_tool_${String(index).padStart(2, '0')}`)
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 100_000, maxToolOutputBytes: 10_000 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: requests === 1
              ? {
                role: 'assistant',
                content: null,
                toolCalls: names.map((name, index) => ({
                  id: `call-${index}`,
                  type: 'function',
                  function: { name, arguments: '{}' },
                })),
              }
              : { role: 'assistant', content: 'done' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const grace = {
    definitions: names.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    execute: async () => '',
  } as unknown as GraceTools

  const result = await agent.run({
    condition: 'grace',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools, grace)

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.toolCalls, 65)
  assert.equal(result.execution.toolUsage.length, 64)
  assert.equal(result.execution.toolUsageTruncated, true)
  assert.deepEqual(result.execution.toolUsage.map(({ name }) => name), names.slice(0, 64))
  assert.deepEqual(result.execution.recentToolCalls.map(({ name }) => name), names.slice(-8))
})

test('publishes bounded approved-command diagnostics without command output', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 10_000,
  }, { maxSteps: 2, maxCostUsd: 30, maxTotalTokens: 100_000, maxToolOutputBytes: 10_000 })
  let requests = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {
          model: 'fixture-model',
          choices: [{
            message: requests === 1
              ? {
                  role: 'assistant',
                  content: null,
                  toolCalls: Array.from({ length: 5 }, (_, index) => ({
                    id: `command-${index}`,
                    type: 'function',
                    function: { name: 'run_command', arguments: '{\"name\":\"api-check\"}' },
                  })),
                }
              : { role: 'assistant', content: 'done' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
        }
      },
    },
  } })
  const tools = new CandidateTools('/tmp', async () => ({
    exitCode: 7,
    signal: null,
    stdout: 'token=\"secret-value-that-must-not-be-published\"',
    stderr: '/Users/private/workspace',
    timedOut: false,
  }), new Set(['api-check']))

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, tools)

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.commandDiagnostics.length, 4)
  assert.equal(result.execution.commandDiagnosticsTruncated, true)
  assert.deepEqual(result.execution.commandDiagnostics[0], {
    schemaVersion: 1,
    step: 1,
    command: 'api-check',
    code: 'command_exit',
    exitCode: 7,
    signal: null,
    timedOut: false,
    reason: 'approved command exited non-zero',
  })
  assert.equal(result.execution.commandDiagnostics[1]?.code, 'command_limit_exceeded')
  assert.equal(result.execution.toolUsage[0]?.errorCount, 4)
  assert.doesNotMatch(JSON.stringify(result.execution), /secret-value|\/Users|workspace/)
})

test('fails with wall_clock_exceeded before sending any request', async () => {
  let requests = 0
  let clockCalls = 0
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 1_000,
  }, { maxSteps: 5, maxCostUsd: 30, maxTotalTokens: 10_000, maxToolOutputBytes: 1_024, wallClockSeconds: 10 }, async () => {}, () => {
    clockCalls += 1
    return clockCalls === 1 ? 0 : 1_000_000
  })
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async () => {
        requests += 1
        return {}
      },
    },
  } })

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.' },
  }, { execute: async () => '' } as unknown as CandidateTools)

  assert.equal(result.status, 'agent_error')
  assert.equal(result.execution.failure?.code, 'wall_clock_exceeded')
  assert.equal(result.execution.requestAttempts, 0)
  assert.equal(requests, 0)
})
