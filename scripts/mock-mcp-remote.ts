/**
 * Mock remote MCP server with OAuth (Streamable HTTP) for tests.
 *
 * - `POST /mcp` answers 401 + resource metadata until a Bearer token is presented.
 * - OAuth discovery, dynamic client registration, authorize (auto-approve) and token endpoints.
 * - JSON-RPC: initialize, tools/list, tools/call, resources/list, resources/read.
 *
 * Usage: bun run scripts/mock-mcp-remote.ts [port]
 */
const port = Number(process.argv[2] ?? 8795)
const origin = `http://127.0.0.1:${port}`

interface RpcRequest {
  id?: unknown
  method?: string
  params?: { name?: string; arguments?: { text?: string }; uri?: string }
}

const TOOL = {
  name: "echo",
  description: "Devuelve el texto recibido (MCP remoto de prueba)",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}

const RESOURCE = { uri: "mock://readme", name: "Mock README", mimeType: "text/plain" }

function rpc(message: RpcRequest): unknown {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "mock-mcp-remote", version: "1.0.0" } }
    case "tools/list":
      return { tools: [TOOL] }
    case "tools/call":
      return { content: [{ type: "text", text: `remote echo: ${message.params?.arguments?.text ?? ""}` }] }
    case "resources/list":
      return { resources: [RESOURCE] }
    case "resources/read":
      return { contents: [{ uri: message.params?.uri ?? RESOURCE.uri, mimeType: "text/plain", text: "MOCK-RESOURCE-OK" }] }
    case "ping":
      return {}
    default:
      return {}
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (process.env.MOCK_MCP_LOG === "1") console.log(`[mock-remote] ${request.method} ${url.pathname}${url.search}`)
    const authorized = (request.headers.get("authorization") ?? "").startsWith("Bearer mock-")

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["tools"],
      })
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { redirect_uris?: string[]; client_name?: string }
      return json(
        {
          client_id: "mock-client",
          client_name: body.client_name ?? "OpenOrch",
          redirect_uris: body.redirect_uris ?? [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        201,
      )
    }
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri") ?? ""
      const state = url.searchParams.get("state") ?? ""
      if (!redirect) return new Response("missing redirect_uri", { status: 400 })
      const target = new URL(redirect)
      target.searchParams.set("code", "mock-code")
      if (state) target.searchParams.set("state", state)
      return new Response(null, { status: 302, headers: { location: target.toString() } })
    }
    if (url.pathname === "/token" && request.method === "POST") {
      return json({ access_token: "mock-token", token_type: "Bearer", expires_in: 3600, scope: "tools" })
    }

    if (url.pathname === "/mcp") {
      if (!authorized) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        })
      }
      const body = (await request.json().catch(() => ({}))) as RpcRequest & { id?: unknown }
      if (body.id === undefined) return new Response(null, { status: 202 })
      return json({ jsonrpc: "2.0", id: body.id, result: rpc(body) })
    }

    return new Response("not found", { status: 404 })
  },
})

console.log(`mock mcp remote on ${origin}`)
void server
