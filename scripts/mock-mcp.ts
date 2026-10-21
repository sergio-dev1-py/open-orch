/**
 * Minimal MCP stdio server for the e2e: newline-delimited JSON-RPC 2.0 on stdio
 * with a single `echo` tool. Usage: bun run scripts/mock-mcp.ts
 */
interface Request {
  id?: unknown
  method?: string
  params?: { name?: string; arguments?: { text?: string } }
}

const decoder = new TextDecoder()
let buffer = ""

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result })
}

function handle(line: string): void {
  let message: Request
  try {
    message = JSON.parse(line) as Request
  } catch {
    return
  }
  if (message.id === undefined) return // notifications have no response
  switch (message.method) {
    case "initialize":
      // MOCK_DELAY simulates a slow server (timeout checks).
      const delay = Number(process.env.MOCK_DELAY ?? 0)
      if (delay > 0) {
        setTimeout(
          () =>
            respond(message.id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
            }),
          delay,
        )
        return
      }
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      })
      return
    case "tools/list": {
      const tools = [
        {
          name: "echo",
          description: "Devuelve el texto recibido (servidor MCP de prueba)",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ]
      // MOCK_ENV proves custom environment variables reach the server process.
      if (process.env.MOCK_ENV) {
        tools.push({
          name: `env_${process.env.MOCK_ENV}`,
          description: "Tool exposed only when MOCK_ENV is set",
          inputSchema: { type: "object", properties: {} },
        })
      }
      respond(message.id, { tools })
      return
    }
    case "tools/call":
      respond(message.id, { content: [{ type: "text", text: `echo: ${message.params?.arguments?.text ?? ""}` }] })
      return
    case "ping":
      respond(message.id, {})
      return
    case "resources/list":
      respond(message.id, { resources: [{ uri: "mock://readme", name: "Mock README", mimeType: "text/plain" }] })
      return
    case "resources/read":
      respond(message.id, { contents: [{ uri: "mock://readme", mimeType: "text/plain", text: "MOCK-RESOURCE-OK" }] })
      return
    case "prompts/list":
      respond(message.id, { prompts: [] })
      return
    default:
      respond(message.id, {})
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true })
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf("\n")
    if (line) handle(line)
  }
})
