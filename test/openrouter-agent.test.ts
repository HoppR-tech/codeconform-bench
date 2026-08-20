import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectionError, RequestTimeoutError } from '@openrouter/sdk/models/errors'
import type { CandidateTools } from '../src/candidate-tools.js'
import type { GraceTools } from '../src/grace-mcp.js'
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
  assert.equal(result.error, 'agent tool-output budget exceeded')
  assert.equal(requests, 1)
  assert.ok(requestedMaxTokens > 0 && requestedMaxTokens < 10_000)
  assert.deepEqual(requestMessages[1], { role: 'user', content: 'Refactor.' })
  assert.match(JSON.stringify(result.trace), /agent tool-output budget exceeded/)
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

  assert.equal(result.status, 'agent_error')
  assert.equal(result.error, 'rate limited')
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

  assert.equal(result.status, 'agent_error')
  assert.equal(result.error, 'provider unavailable')
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

  assert.equal(result.status, 'agent_error')
  assert.equal(result.error, 'request timed out')
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
  assert.equal(result.error, 'agent cost budget exceeded')
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

  assert.equal(result.status, 'agent_error')
  assert.equal(result.error, 'OpenRouter returned no completion choice')
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

  assert.equal(result.status, 'agent_error')
  assert.match(result.error ?? '', /invalid token or cost usage/)
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
  assert.equal(result.error, 'agent step budget exhausted')
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
