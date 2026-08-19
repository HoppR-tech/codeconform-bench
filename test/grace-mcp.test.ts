import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { connectGraceMcp } from '../src/grace-mcp.js'

test('connects with bearer auth and terminates its live MCP session', async () => {
  const app = createMcpExpressApp()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let authorization: string | undefined
  let terminated = false
  let failDiscovery = false
  app.use((request: IncomingMessage, _response: ServerResponse, next: () => void) => {
    authorization = request.headers.authorization
    next()
  })
  app.post('/mcp', async (request: IncomingMessage & { body?: unknown }, response: ServerResponse) => {
    if (failDiscovery && request.body && typeof request.body === 'object' && 'method' in request.body && request.body.method === 'tools/list') {
      response.statusCode = 500
      response.end()
      return
    }
    const header = request.headers['mcp-session-id']
    let transport = typeof header === 'string' ? transports.get(header) : undefined
    if (!transport) {
      const server = new McpServer({ name: 'fixture-grace', version: '1.0.0' }, { instructions: 'Use the live Grace tool.' })
      server.registerTool('grace_check', { description: 'Check architecture.' }, async () => ({
        content: [{ type: 'text', text: 'architecture checked' }],
      }))
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => 'fixture-session',
        onsessioninitialized: (sessionId) => { transports.set(sessionId, transport!) },
      })
      transport.onclose = () => { transports.delete('fixture-session') }
      await server.connect(transport as Parameters<McpServer['connect']>[0])
    }
    await transport.handleRequest(request, response, request.body)
  })
  app.delete('/mcp', async (request: IncomingMessage, response: ServerResponse) => {
    const header = request.headers['mcp-session-id']
    const transport = typeof header === 'string' ? transports.get(header) : undefined
    if (!transport) {
      response.statusCode = 400
      response.end()
      return
    }
    terminated = true
    await transport.handleRequest(request, response)
  })

  const httpServer = app.listen(0)
  await once(httpServer, 'listening')
  const address = httpServer.address()
  assert.ok(address && typeof address === 'object')

  try {
    const grace = await connectGraceMcp(`http://127.0.0.1:${address.port}/mcp`, 'fixture-token')
    assert.equal(authorization, 'Bearer fixture-token')
    assert.equal(grace.instructions, 'Use the live Grace tool.')
    assert.deepEqual(grace.definitions.map((tool) => tool.function.name), ['grace_check'])
    assert.match(await grace.execute('grace_check', '{}'), /architecture checked/)
    await assert.rejects(() => grace.execute('grace_check', '[]'), /must be a JSON object/)
    await grace.close()
    assert.equal(terminated, true)
    assert.equal(transports.size, 0)
    terminated = false
    failDiscovery = true
    await assert.rejects(() => connectGraceMcp(`http://127.0.0.1:${address.port}/mcp`, 'fixture-token'))
    assert.equal(terminated, true)
    assert.equal(transports.size, 0)
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((error?: Error) => error ? reject(error) : resolve()))
  }
})
