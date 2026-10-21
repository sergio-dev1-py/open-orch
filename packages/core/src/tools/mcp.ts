import { z } from "zod"
import type { ToolDefinition } from "./types.js"
import { textOutput, ToolFailure, type ToolContext } from "./types.js"

/**
 * `mcp` tool: the agent can install, probe and remove MCP servers from the chat.
 * It goes through the same path as `Ajustes → MCP`: the config is updated and the
 * servers reconnect live (no restart), reporting the tools each server exposes.
 */
export const mcpTool: ToolDefinition = {
  name: "mcp",
  description: [
    "Manage MCP (Model Context Protocol) servers.",
    "`list` shows configured servers with their status and tools.",
    "`add` installs a server — a local `command` (stdio) or a remote `url` (Streamable HTTP) — connects it and reports the tools it exposes.",
    "`test` probes a connection without saving it (by `name` of a configured server or with `type` + `command`/`url`).",
    "`remove` deletes a server.",
    "Use it when the user asks to install, verify or uninstall an MCP server, then report the tools it provides.",
  ].join(" "),
  inputSchema: z.object({
    action: z.enum(["list", "add", "test", "remove"]).describe("Operation to run."),
    name: z
      .string()
      .optional()
      .describe("Server name: required for add/remove; optional for test to probe an already configured server."),
    type: z.enum(["local", "remote"]).optional().describe("Server type for add/test."),
    command: z
      .string()
      .optional()
      .describe("Local server command line, e.g. `npx -y @modelcontextprotocol/server-filesystem /path`."),
    url: z.string().optional().describe("Remote server URL (Streamable HTTP)."),
    headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers for remote servers (e.g. an API key)."),
    enabled: z.boolean().optional().describe("Enable the server immediately (default true)."),
  }),
  async execute(
    input: {
      action: "list" | "add" | "test" | "remove"
      name?: string
      type?: "local" | "remote"
      command?: string
      url?: string
      headers?: Record<string, string>
      enabled?: boolean
    },
    ctx: ToolContext,
  ) {
    await ctx.permission({ action: "mcp", resources: [input.action], save: [] })

    const draft = () => {
      const type = input.type ?? (input.url ? "remote" : "local")
      if (type === "remote") {
        if (!input.url) throw new ToolFailure("A remote MCP server needs a `url`.")
        return { type: "remote" as const, url: input.url.trim(), ...(input.headers ? { headers: input.headers } : {}), enabled: input.enabled ?? true }
      }
      if (!input.command) throw new ToolFailure("A local MCP server needs a `command`.")
      return {
        type: "local" as const,
        command: input.command.trim().split(/\s+/),
        enabled: input.enabled ?? true,
      }
    }

    if (input.action === "list") {
      const servers = ctx.services.mcp.status()
      if (servers.length === 0) return textOutput("No MCP servers are configured.")
      const lines = servers.map((server) => {
        const scope = server.scope === "project" ? " · project" : ""
        if (server.status === "connected") {
          return `- ${server.name}: connected${scope} · ${server.tools} tools${server.toolNames.length > 0 ? ` (${server.toolNames.join(", ")})` : ""}`
        }
        if (server.status === "needs-auth") return `- ${server.name}: needs-auth${scope} — the user must sign in from Settings → MCP`
        return `- ${server.name}: error${scope}${server.error ? ` — ${server.error}` : ""}`
      })
      return textOutput(`MCP servers:\n${lines.join("\n")}`, { servers })
    }

    if (input.action === "add") {
      const name = input.name?.trim()
      if (!name) throw new ToolFailure("An MCP server needs a `name`.")
      const status = await ctx.services.mcp.add(name, draft())
      if (status.status === "needs-auth") {
        // Installed and reachable, but the server requires OAuth: the user signs in.
        return textOutput(
          `MCP server "${name}" installed. It requires authentication: tell the user to press “Iniciar sesión” in Settings → MCP (tokens are stored in mcp-auth.json and reused afterwards).`,
          { name, needsAuth: true },
        )
      }
      if (status.status !== "connected") {
        throw new ToolFailure(`MCP server "${name}" failed to connect${status.error ? `: ${status.error}` : "."}`)
      }
      return textOutput(
        `MCP server "${name}" installed and connected. Tools: ${status.toolNames.length > 0 ? status.toolNames.join(", ") : "(none)"}. It is already available in this session.`,
        { name, tools: status.toolNames },
      )
    }

    if (input.action === "test") {
      const name = input.name?.trim()
      const configured = name ? ctx.services.mcp.get(name) : undefined
      const server = configured && !input.command && !input.url ? configured : draft()
      const result = await ctx.services.mcp.test(server, name)
      if (result.needsAuth) {
        return textOutput(`MCP server "${name ?? "server"}" requires authentication (OAuth). The user must sign in from Settings → MCP.`, {
          needsAuth: true,
        })
      }
      if (!result.ok) throw new ToolFailure(`MCP connection failed${result.error ? `: ${result.error}` : "."}`)
      return textOutput(`MCP connection OK. Tools: ${result.tools.length > 0 ? result.tools.join(", ") : "(none)"}.`, {
        tools: result.tools,
      })
    }

    const name = input.name?.trim()
    if (!name) throw new ToolFailure("An MCP server needs a `name`.")
    await ctx.services.mcp.remove(name)
    return textOutput(`MCP server "${name}" removed.`)
  },
}

/** Resources exposed by connected MCP servers (mirrors opencode's mcp-resource tools). */
export const mcpListResourcesTool: ToolDefinition = {
  namespace: "mcp",
  codemode: true,
  name: "list_resources",
  description:
    "List resources (files, records, documents…) exposed by connected MCP servers. Optionally filter by server name.",
  inputSchema: z.object({
    server: z.string().optional().describe("Only list resources from this MCP server."),
  }),
  async execute(input: { server?: string }, ctx: ToolContext) {
    const groups = await ctx.services.mcp.listResources(input.server)
    const lines = groups.flatMap((group) =>
      group.resources.map((resource) => `- [${group.server}] ${resource.uri}${resource.name ? ` — ${resource.name}` : ""}`),
    )
    if (lines.length === 0) return textOutput("No MCP resources available.")
    return textOutput(`MCP resources:\n${lines.join("\n")}`)
  },
}

export const mcpReadResourceTool: ToolDefinition = {
  namespace: "mcp",
  codemode: true,
  name: "read_resource",
  description: "Read one resource from a connected MCP server by its URI (see mcp_list_resources).",
  inputSchema: z.object({
    server: z.string().describe("MCP server name."),
    uri: z.string().describe("Resource URI."),
  }),
  async execute(input: { server: string; uri: string }, ctx: ToolContext) {
    const content = await ctx.services.mcp.readResource(input.server, input.uri)
    return { content, metadata: { server: input.server, uri: input.uri } }
  },
}
