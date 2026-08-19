import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ChatFunctionTool } from '@openrouter/sdk/models'
type GraceFunctionTool = Extract<ChatFunctionTool, { type: 'function' }>

export interface GraceTools {
  readonly definitions: readonly GraceFunctionTool[]
  readonly instructions?: string
  execute(name: string, input: string): Promise<string>
  close(): Promise<void>
}

export async function connectGraceMcp(url: string, token: string): Promise<GraceTools> {
  const client = new Client({ name: 'codeconform-bench', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const close = async () => {
    try {
      await transport.terminateSession()
    } finally {
      await client.close()
    }
  }

  try {
    // SDK 1.29's transport types do not model exactOptionalPropertyTypes, though this is its native client transport.
    await client.connect(transport as Parameters<Client['connect']>[0])
    const definitions: GraceFunctionTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      definitions.push(...page.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.inputSchema,
        },
      })))
      cursor = page.nextCursor
    } while (cursor)

    const instructions = client.getInstructions()
    return {
      definitions,
      ...(instructions ? { instructions } : {}),
      execute: async (name, input) => {
        const args: unknown = JSON.parse(input)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Grace MCP tool arguments must be a JSON object')
        return JSON.stringify(await client.callTool({ name, arguments: args as Record<string, unknown> }))
      },
      close,
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
