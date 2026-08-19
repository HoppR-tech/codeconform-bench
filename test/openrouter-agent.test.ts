import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CandidateTools } from '../src/candidate-tools.js'
import { OpenRouterAgent } from '../src/openrouter-agent.js'

test('stops before feeding oversized tool output back to the model', async () => {
  const agent = new OpenRouterAgent('fixture-key', {
    id: 'fixture-model',
    providerOrder: ['fixture-provider'],
    allowFallbacks: false,
    maxTokens: 100_000,
  }, { maxSteps: 2, maxTotalTokens: 10_000, maxToolOutputBytes: 16 })
  let requests = 0
  let requestedMaxTokens = 0
  Object.defineProperty(agent, 'client', { value: {
    chat: {
      send: async (request: { chatRequest: { maxTokens: number } }) => {
        requests += 1
        requestedMaxTokens = request.chatRequest.maxTokens
        return {
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"large"}' } }] } }],
          usage: { promptTokens: 10, completionTokens: 5 },
        }
      },
    },
  } })
  const tools = { execute: async () => 'x'.repeat(17) } as unknown as CandidateTools

  const result = await agent.run({
    condition: 'baseline',
    pairId: 'pair-01',
    workspace: '/tmp/candidate',
    task: { id: 'fixture', prompt: 'Refactor.', architectureIntent: 'Use ports.' },
  }, tools)

  assert.equal(result.status, 'agent_error')
  assert.equal(result.error, 'agent tool-output budget exceeded')
  assert.equal(requests, 1)
  assert.ok(requestedMaxTokens > 0 && requestedMaxTokens < 10_000)
  assert.match(JSON.stringify(result.trace), /agent tool-output budget exceeded/)
})
