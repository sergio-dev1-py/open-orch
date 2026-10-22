import { createServer } from "node:http"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { McpServerConfig, McpServerStatus, ToolContent } from "@openorch/shared"
import type { ToolDefinition, ToolContext } from "./tools/types.js"
import { ToolFailure } from "./tools/types.js"
import { truncate } from "./util.js"

/** One configured server plus where its entry comes from. */
export interface McpServerEntry {
  config: McpServerConfig
  scope: "global" | "project"
}

interface ServerState {
  name: string
  scope: "global" | "project"
  client?: Client
  transport?: StdioClientTransport | StreamableHTTPClientTransport
  pid?: number
  status: "connected" | "error" | "needs-auth"
  error?: string
}

interface StoredAuth {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  codeVerifier?: string
}

export interface McpManagerOptions {
  dataDir: string
  /** Opens an authorization URL (the app wires this to `shell.openExternal`). */
  openUrl?: (url: string) => void
}

/**
 * Connects MCP servers (local stdio and remote Streamable HTTP), registers their
 * tools, supports OAuth for remote servers (tokens in `mcp-auth.json`) and keeps
 * per-server status for the UI. A server that answers 401 becomes `needs-auth`
 * (never a hard error) so public servers are unaffected.
 */
export class McpManager {
  private servers = new Map<string, ServerState>()
  private toolDefs: ToolDefinition[] = []
  private serverLines: string[] = []
  private entries: Record<string, McpServerEntry> = {}
  private authFile: string
  private auth: Record<string, StoredAuth> = {}

  constructor(
    private options: McpManagerOptions,
    private onStatus: (status: string) => void,
  ) {
    this.authFile = path.join(options.dataDir, "mcp-auth.json")
    this.loadAuth()
  }

  updateServers(entries: Record<string, McpServerEntry>): void {
    this.entries = entries
  }

  tools(): ToolDefinition[] {
    return this.toolDefs
  }

  instructions(): string {
    const lines = [
      "# MCP",
      "Manage MCP servers with the `mcp` tool: `list` (servers, scope, status and tools), `add` (local command or remote URL; it connects and reports the discovered tools), `test` (probe a connection without saving it) and `remove`.",
      "When the user asks to install an MCP server (a URL, package or repository), use the `mcp` tool, verify the connection with `test`/the add result, and report the tools it exposes.",
      "A server can require OAuth: if the result says `needs-auth`, tell the user to press “Iniciar sesión” in Settings → MCP (their tokens are stored and reused afterwards).",
    ]
    if (this.serverLines.length > 0) lines.push(`Connected servers: ${this.serverLines.join("; ")}`)
    return lines.join("\n")
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((state) => {
      const toolNames = this.toolDefs.filter((tool) => tool.namespace === sanitize(state.name)).map((tool) => tool.name)
      const config = this.entries[state.name]?.config
      return {
        name: state.name,
        status: state.status,
        error: state.error,
        tools: toolNames.length,
        toolNames,
        scope: state.scope,
        target: config?.type === "remote" ? config.url : config?.command?.join(" "),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  async connectAll(): Promise<void> {
    await this.closeAll()
    this.toolDefs = []
    this.serverLines = []
    const entries = Object.entries(this.entries).filter(([, entry]) => entry.config.enabled !== false)
    if (entries.length === 0) {
      // Always notify: disabling every server must clear stale status badges in the UI.
      this.onStatus("no servers enabled")
      return
    }
    await Promise.allSettled(
      entries.map(async ([name, entry]) => {
        await this.connect(name, entry)
      }),
    )
    await this.rebuildTools()
  }

  /**
   * Applies a new server set without restarting servers whose configuration is
   * unchanged. Workspace switches usually leave the global MCP set untouched;
   * reconnecting `npx`-launched servers there costs seconds and leaks children
   * on Windows if the whole process tree is not terminated.
   */
  async sync(entries: Record<string, McpServerEntry>): Promise<void> {
    const previous = this.entries
    const names = new Set([...Object.keys(previous), ...Object.keys(entries)])
    const changed: string[] = []
    for (const name of names) {
      const before = previous[name]
      const after = entries[name]
      if (!before || !after || before.scope !== after.scope || JSON.stringify(before.config) !== JSON.stringify(after.config)) {
        changed.push(name)
      }
    }
    this.entries = entries
    for (const name of changed) {
      const state = this.servers.get(name)
      if (!state) continue
      this.servers.delete(name)
      await this.closeState(state)
    }
    for (const name of changed) {
      const entry = entries[name]
      if (!entry || entry.config.enabled === false) continue
      await this.connect(name, entry)
    }
    await this.rebuildTools()
    this.onStatus(changed.length === 0 ? "MCP configuration unchanged" : `MCP servers updated: ${changed.join(", ")}`)
  }

  private async rebuildTools(): Promise<void> {
    this.toolDefs = []
    this.serverLines = []
    for (const [name, state] of this.servers) {
      if (state.status !== "connected" || !state.client) continue
      const serverTools = await this.collectTools(name, state.client, this.entries[name]?.config).catch((error) => {
        state.status = "error"
        state.error = error instanceof Error ? error.message : String(error)
        this.onStatus(`server ${name} tools failed: ${state.error}`)
        return []
      })
      this.toolDefs.push(...serverTools)
      if (serverTools.length > 0) {
        this.serverLines.push(`"${name}" provides: ${serverTools.map((tool) => tool.name).join(", ")}`)
      }
    }
  }

  private async closeState(state: ServerState): Promise<void> {
    const pid = state.pid
    // Kill the tree before asking the SDK to close. The SDK waits up to four
    // seconds for a stdio child, and killing only the cmd/npx wrapper leaves
    // its Node descendants alive on Windows.
    if (pid) killProcessTree(pid)
    await Promise.race([
      Promise.resolve(state.client?.close?.()).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 750)),
    ])
  }

  /** Builds the transport for a server entry (shared by connect, probe and auth). */
  private transportFor(server: McpServerConfig, name?: string): StdioClientTransport | StreamableHTTPClientTransport {
    if (server.type === "remote") {
      if (!server.url) throw new Error("Missing url for remote MCP server")
      // Attach the OAuth provider only when there are stored tokens: a plain connect must
      // never pop the browser (a 401 becomes `needs-auth` and the user signs in on purpose).
      const authProvider = name && this.hasTokens(name) ? this.authProviderFor(name, server) : undefined
      return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
        ...(authProvider ? { authProvider } : {}),
      })
    }
    if (!server.command || server.command.length === 0) throw new Error("Missing command for local MCP server")
    const [command, ...args] = server.command
    return new StdioClientTransport({
      command,
      args,
      stderr: "ignore",
      // The SDK merges these over the inherited default environment.
      ...(server.environment ? { env: { ...getDefaultEnvironment(), ...server.environment } } : {}),
    })
  }

  /** Per-request timeout options for the SDK client calls. */
  private requestOptions(server: McpServerConfig | undefined) {
    return server?.timeout && server.timeout > 0 ? { timeout: server.timeout } : undefined
  }

  private async connect(name: string, entry: McpServerEntry): Promise<void> {
    const server = entry.config
    const transport = this.transportFor(server, name)
    const pid = transportPid(transport)
    try {
      const client = new Client({ name: "openorch", version: "0.1.0" })
      await withTimeout(
        client.connect(transport),
        server.timeout && server.timeout > 0 ? server.timeout * 4 : 30_000,
        `MCP server "${name}" timed out while connecting`,
      )
      this.servers.set(name, { name, scope: entry.scope, client, transport, pid, status: "connected" })
      this.onStatus(`connected: ${name}`)
    } catch (error) {
      killProcessTree(pid)
      await this.closeState({ name, scope: entry.scope, client: undefined, transport, pid, status: "error" })
      const needsAuth = error instanceof UnauthorizedError || /unauthorized|401/i.test(error instanceof Error ? error.message : String(error))
      this.servers.set(name, {
        name,
        scope: entry.scope,
        client: undefined,
        status: needsAuth ? "needs-auth" : "error",
        error: needsAuth ? undefined : error instanceof Error ? error.message : String(error),
      })
      this.onStatus(needsAuth ? `needs auth: ${name}` : `failed: ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Connects once, lists tools and disconnects (mcp tool `test`). */
  async probe(server: McpServerConfig, name?: string): Promise<{ ok: boolean; tools: string[]; needsAuth?: boolean; error?: string }> {
    const client = new Client({ name: "openorch", version: "0.1.0" })
    const transport = this.transportFor(server, name)
    const pid = transportPid(transport)
    try {
      await withTimeout(
        client.connect(transport),
        server.timeout && server.timeout > 0 ? server.timeout * 4 : 30_000,
        "MCP connection timed out",
      )
      const result = await client.listTools(undefined, this.requestOptions(server))
      const tools = (result.tools ?? []).map((tool) => tool.name)
      killProcessTree(pid)
      await client.close().catch(() => undefined)
      return { ok: true, tools }
    } catch (error) {
      killProcessTree(pid)
      await client.close().catch(() => undefined)
      const needsAuth = error instanceof UnauthorizedError || /unauthorized|401/i.test(error instanceof Error ? error.message : String(error))
      return { ok: false, tools: [], needsAuth, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // -------------------------------------------------------------------------
  // OAuth (remote servers only, and only when the server asks for it)
  // -------------------------------------------------------------------------

  private loadAuth(): void {
    try {
      this.auth = JSON.parse(readFileSync(this.authFile, "utf8")) as Record<string, StoredAuth>
    } catch {
      this.auth = {}
    }
  }

  private saveAuth(): void {
    try {
      mkdirSync(path.dirname(this.authFile), { recursive: true })
      writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2), "utf8")
    } catch {
      // Best effort: without the file the flow still works for this session.
    }
  }

  hasTokens(name: string): boolean {
    return Boolean(this.auth[name]?.tokens?.access_token)
  }

  /** Runs the browser OAuth flow for a remote server and reconnects it. */
  async authenticate(name: string): Promise<McpServerStatus | undefined> {
    const entry = this.entries[name]
    if (!entry || entry.config.type !== "remote" || !entry.config.url) {
      throw new ToolFailure(`MCP server "${name}" is not a remote server.`)
    }
    const callback = await startCallbackServer()
    try {
      const makeTransport = () =>
        new StreamableHTTPClientTransport(new URL(entry.config.url as string), {
          requestInit: entry.config.headers ? { headers: entry.config.headers } : undefined,
          authProvider: this.authProviderFor(name, entry.config, callback.redirectUrl),
        })
      const client = new Client({ name: "openorch", version: "0.1.0" })
      try {
        await client.connect(makeTransport())
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error
        // The SDK discovered the authorization server and opened the browser.
        const code = await callback.waitForCode()
        const authorized = makeTransport()
        await authorized.finishAuth(code)
        // The first transport is already started: reconnect with a fresh one.
        await client.connect(authorized)
      }
      await client.close().catch(() => undefined)
      this.onStatus(`authenticated: ${name}`)
      await this.connectAll()
      return this.status().find((server) => server.name === name)
    } finally {
      callback.close()
    }
  }

  /** Forgets stored OAuth tokens (the server goes back to `needs-auth`). */
  async logout(name: string): Promise<void> {
    delete this.auth[name]
    this.saveAuth()
    this.onStatus(`logged out: ${name}`)
    await this.connectAll()
  }

  private authProviderFor(name: string, server: McpServerConfig, redirectUrl?: string): OAuthClientProvider {
    return new ServerOAuthProvider(name, server, redirectUrl, this)
  }

  readAuth(name: string): StoredAuth {
    return this.auth[name] ?? {}
  }

  writeAuth(name: string, patch: Partial<StoredAuth>): void {
    this.auth[name] = { ...this.readAuth(name), ...patch }
    this.saveAuth()
  }

  /** The test hook lets the e2e complete the flow without opening a real browser. */
  openAuthorizationUrl(url: URL, redirectUrl: string): void {
    if (process.env.OPENORCH_MCP_AUTH_AUTO === "1") {
      // Follow the authorization URL like a browser would (the mock redirects to the callback).
      void fetch(url).catch(() => undefined)
      return
    }
    this.options.openUrl?.(url.toString())
  }

  // -------------------------------------------------------------------------
  // Tools and resources
  // -------------------------------------------------------------------------

  private async collectTools(serverName: string, client: Client, server?: McpServerConfig): Promise<ToolDefinition[]> {
    const result = await client.listTools(undefined, this.requestOptions(server))
    const namespace = sanitize(serverName)
    return (result.tools ?? []).map((tool) => {
      const toolName = sanitize(tool.name)
      const effective = `${namespace}_${toolName}`
      const definition: ToolDefinition = {
        name: toolName,
        namespace,
        codemode: true,
        description: tool.description ?? "",
        jsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
        permission: effective,
        execute: async (input: unknown, ctx: ToolContext) => {
          await ctx.permission({ action: effective, resources: ["*"], save: ["*"] })
          const response = await client.callTool(
            { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
            undefined,
            this.requestOptions(server),
          )
          const content: ToolContent[] = []
          const rawContent = (response as { content?: unknown[] }).content ?? []
          for (const item of rawContent) {
            const entry = item as { type?: string; text?: string; data?: string; mimeType?: string }
            if (entry.type === "text" && entry.text) content.push({ type: "text", text: entry.text })
            if (entry.type === "image" && entry.data) {
              content.push({
                type: "file",
                url: `data:${entry.mimeType ?? "image/png"};base64,${entry.data}`,
                mime: entry.mimeType ?? "image/png",
              })
            }
          }
          const text = content
            .filter((item) => item.type === "text")
            .map((item) => (item as { text: string }).text)
            .join("\n")
          if ((response as { isError?: boolean }).isError) {
            throw new ToolFailure(truncate(text || "MCP tool failed", 20_000))
          }
          if (content.length === 0) content.push({ type: "text", text: "(no output)" })
          return { content, metadata: { server: serverName, tool: tool.name } }
        },
      }
      return definition
    })
  }

  /** Resources exposed by connected servers (MCP `resources/list`). */
  async listResources(serverName?: string): Promise<{ server: string; resources: { uri: string; name?: string; mimeType?: string }[] }[]> {
    const out: { server: string; resources: { uri: string; name?: string; mimeType?: string }[] }[] = []
    for (const [name, state] of this.servers) {
      if (state.status !== "connected" || !state.client) continue
      if (serverName && name !== serverName) continue
      try {
        const result = await state.client.listResources(undefined, this.requestOptions(this.entries[name]?.config))
        out.push({
          server: name,
          resources: (result.resources ?? []).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            mimeType: resource.mimeType,
          })),
        })
      } catch {
        // Servers without resource support simply contribute nothing.
      }
    }
    return out
  }

  /** Reads one resource (MCP `resources/read`). */
  async readResource(serverName: string, uri: string): Promise<ToolContent[]> {
    const state = this.servers.get(serverName)
    if (!state || state.status !== "connected" || !state.client) {
      throw new ToolFailure(`MCP server "${serverName}" is not connected.`)
    }
    const result = await state.client.readResource({ uri }, this.requestOptions(this.entries[serverName]?.config))
    const content: ToolContent[] = []
    for (const item of result.contents ?? []) {
      const entry = item as { uri?: string; mimeType?: string; text?: string; blob?: string }
      if (typeof entry.text === "string") content.push({ type: "text", text: entry.text })
      else if (typeof entry.blob === "string") {
        content.push({
          type: "file",
          url: `data:${entry.mimeType ?? "application/octet-stream"};base64,${entry.blob}`,
          mime: entry.mimeType ?? "application/octet-stream",
        })
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "(empty resource)" })
    return content
  }

  async closeAll(): Promise<void> {
    for (const state of [...this.servers.values()]) {
      await this.closeState(state)
    }
    this.servers.clear()
  }
}

// ---------------------------------------------------------------------------
// OAuth provider (SDK interface) backed by mcp-auth.json
// ---------------------------------------------------------------------------

class ServerOAuthProvider implements OAuthClientProvider {
  constructor(
    private name: string,
    private server: McpServerConfig,
    private redirect: string | undefined,
    private manager: McpManager,
  ) {}

  get redirectUrl(): string | undefined {
    return this.redirect
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "OpenOrch",
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.server.oauth?.clientSecret ? "client_secret_post" : "none",
      ...(this.server.oauth?.scope ? { scope: this.server.oauth.scope } : {}),
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.server.oauth?.clientId) {
      return {
        client_id: this.server.oauth.clientId,
        ...(this.server.oauth.clientSecret ? { client_secret: this.server.oauth.clientSecret } : {}),
      }
    }
    return this.manager.readAuth(this.name).clientInformation
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.manager.writeAuth(this.name, { clientInformation: info })
  }

  tokens(): OAuthTokens | undefined {
    return this.manager.readAuth(this.name).tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.manager.writeAuth(this.name, { tokens })
  }

  redirectToAuthorization(url: URL): void {
    this.manager.openAuthorizationUrl(url, this.redirect ?? "")
  }

  saveCodeVerifier(verifier: string): void {
    this.manager.writeAuth(this.name, { codeVerifier: verifier })
  }

  codeVerifier(): string {
    const verifier = this.manager.readAuth(this.name).codeVerifier
    if (!verifier) throw new Error("Missing PKCE code verifier for the MCP OAuth flow.")
    return verifier
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const patch: Partial<StoredAuth> = {}
    if (scope === "all" || scope === "tokens") patch.tokens = undefined
    if (scope === "all" || scope === "client") patch.clientInformation = undefined
    if (scope === "all" || scope === "verifier") patch.codeVerifier = undefined
    this.manager.writeAuth(this.name, patch)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Merges global MCP entries with the project's files (`.opencode/mcp.json` then
 * `.openorch/mcp.json`, native wins). Pure so it can be unit-tested.
 */
export function mergeMcpServers(
  globalServers: Record<string, McpServerConfig>,
  projectFiles: Record<string, McpServerConfig>[],
): Record<string, McpServerEntry> {
  const entries: Record<string, McpServerEntry> = {}
  for (const [name, config] of Object.entries(globalServers)) entries[name] = { config, scope: "global" }
  for (const file of projectFiles) {
    for (const [name, config] of Object.entries(file ?? {})) {
      if (!config || typeof config !== "object") continue
      entries[name] = { config, scope: "project" }
    }
  }
  return entries
}

/** Local callback server for the OAuth redirect (`http://127.0.0.1:<port>/callback`). */
function startCallbackServer(): Promise<{ redirectUrl: string; waitForCode: () => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void = () => undefined
    let rejectCode: (error: Error) => void = () => undefined
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== "/callback") {
        response.writeHead(404).end()
        return
      }
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<html><body style="font-family:system-ui;padding:40px"><h2>${
          error ? "OpenOrch: autorización rechazada" : "OpenOrch: autorización completada"
        }</h2><p>${error ?? "Ya puedes cerrar esta pestaña y volver a OpenOrch."}</p></body></html>`,
      )
      if (error) rejectCode(new Error(`OAuth error: ${error}`))
      else if (code) resolveCode(code)
      else rejectCode(new Error("OAuth callback without a code"))
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not start the OAuth callback server"))
        return
      }
      resolve({
        redirectUrl: `http://127.0.0.1:${address.port}/callback`,
        waitForCode: () => codePromise,
        close: () => server.close(),
      })
    })
  })
}

function transportPid(transport: StdioClientTransport | StreamableHTTPClientTransport): number | undefined {
  return transport instanceof StdioClientTransport ? (transport.pid ?? undefined) : undefined
}

/**
 * Kills an MCP stdio process and its descendants. `Client.close()` only signals
 * the direct cmd/npx wrapper on Windows; the real agent Node process otherwise
 * stays alive and keeps consuming hundreds of MB after a workspace switch.
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    } catch {
      // best effort
    }
    return
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone
  }
}

/** Races a promise against a timeout so a hung server never blocks the app. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sanitize(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "_")
}
