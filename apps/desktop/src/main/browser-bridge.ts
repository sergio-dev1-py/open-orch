import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BrowserTabInfo } from "@openorch/core"
import { WebSocketServer, WebSocket, type RawData } from "ws"

/**
 * Local bridge between OpenOrch and the Edge/Chrome extension.
 *
 * Security model:
 * - listens on 127.0.0.1 only;
 * - accepts WebSocket upgrades only from extension origins;
 * - requires the pairing token stored in <dataDir>/browser-bridge.json.
 * There is no cloud hop and no remote access.
 */

export interface BridgeInfo {
  connected: boolean
  port: number
  token: string
  browser: string
  version: string
  lastError: string
  tabs: BrowserTabInfo[]
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const ORIGIN = /^(chrome|extension|moz)-extension:\/\//i
const DEFAULT_PORT = 45_871
const CALL_TIMEOUT = 60_000
const HEARTBEAT_MS = 25_000
const HEARTBEAT_MISSES = 3

function readableToken(): string {
  const raw = randomBytes(16)
    .toString("base64url")
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "")
    .padEnd(12, "X")
    .slice(0, 12)
  return `ORCH-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseTabs(value: unknown): BrowserTabInfo[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      url: typeof entry.url === "string" ? entry.url : "",
      title: typeof entry.title === "string" ? entry.title : "",
    }))
    .filter((entry) => entry.id.length > 0)
}

export class ExtensionBridge {
  private server?: WebSocketServer
  private socket?: WebSocket
  private pending = new Map<string, Pending>()
  private tabs: BrowserTabInfo[] = []
  private tabsListener?: (tabs: BrowserTabInfo[]) => void
  private token: string
  private port = 0
  private browser = ""
  private version = ""
  private lastError = ""
  private counter = 0
  private heartbeat?: NodeJS.Timeout
  private lastPong = 0

  constructor(private dataDir: string) {
    this.token = this.loadToken()
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get info(): BridgeInfo {
    return {
      connected: this.connected,
      port: this.port,
      token: this.token,
      browser: this.browser,
      version: this.version,
      lastError: this.lastError,
      tabs: this.tabs,
    }
  }

  onTabs(listener: (tabs: BrowserTabInfo[]) => void): void {
    this.tabsListener = listener
  }

  /** Adds/updates a tab immediately, without waiting for the extension's debounce. */
  rememberTab(tab: BrowserTabInfo): void {
    if (!tab.id) return
    const next = this.tabs.filter((entry) => entry.id !== tab.id)
    next.push(tab)
    this.setTabs(next)
  }

  replaceTabs(tabs: BrowserTabInfo[]): void {
    this.setTabs(tabs)
  }

  /** Pulls the current group tabs from the extension and updates the cache. */
  async refreshTabs(): Promise<BrowserTabInfo[]> {
    if (!this.connected) return []
    const result = (await this.call("list", {})) as { tabs?: unknown }
    this.setTabs(parseTabs(result?.tabs))
    return this.tabs
  }

  async start(): Promise<number> {
    if (this.server) return this.port
    const ports = [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2, DEFAULT_PORT + 3, DEFAULT_PORT + 4, 0]
    let lastError: unknown
    for (const port of ports) {
      const server = new WebSocketServer({ host: "127.0.0.1", port })
      server.on("connection", (socket, request) => this.accept(socket, request.headers.origin ?? ""))
      server.on("error", (error) => {
        console.error("[browser] bridge error:", error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", () => resolve())
          server.once("error", (error) => reject(error))
        })
        this.server = server
        const address = server.address()
        this.port = typeof address === "object" && address ? address.port : port
        break
      } catch (error) {
        lastError = error
        try {
          server.close()
        } catch {
          // Not listening.
        }
        const code = (error as { code?: string }).code
        if (code !== "EADDRINUSE" && port !== 0) throw error
      }
    }
    if (!this.server) throw lastError instanceof Error ? lastError : new Error("Could not start the browser bridge.")
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return this.port
  }

  async call(op: string, args: Record<string, unknown> = {}, timeout = CALL_TIMEOUT): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error(
        "[browser.extension] The OpenOrch browser extension is not connected. Open Edge, click the OpenOrch Browser icon and connect it (Ajustes → Navegador), or switch to the integrated browser.",
      )
    }
    const id = `call_${++this.counter}_${Date.now().toString(36)}`
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[browser.extension] The browser did not answer "${op}" in ${Math.round(timeout / 1000)}s.`))
      }, timeout)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type: "call", id, op, args }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  disconnect(): void {
    this.lastError = "Desconectado desde OpenOrch."
    try {
      this.socket?.send(JSON.stringify({ type: "disable" }))
    } catch {
      // Already closed.
    }
    const socket = this.socket
    this.socket = undefined
    this.rejectAll(new Error("[browser.extension] The extension was disconnected."))
    this.tabs = []
    this.tabsListener?.([])
    // Give the disable frame a chance to flush before closing.
    setTimeout(() => {
      try {
        socket?.close()
      } catch {
        // Already closed.
      }
    }, 100).unref?.()
  }

  resetToken(): string {
    this.disconnect()
    this.token = readableToken()
    this.saveToken(this.token)
    return this.token
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    // Closing the app must not disable the extension: it reconnects on the next launch.
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close()
    } catch {
      // Already closed.
    }
    this.rejectAll(new Error("[browser.extension] OpenOrch is closing."))
    this.tabs = []
    this.tabsListener?.([])
    try {
      this.server?.close()
    } catch {
      // Already closed.
    }
    this.server = undefined
  }

  // -------------------------------------------------------------------------

  private accept(socket: WebSocket, origin: string): void {
    if (!ORIGIN.test(origin)) {
      socket.close(1008, "Origin not allowed")
      return
    }
    let authenticated = false
    const reject = (reason: string) => {
      this.lastError = reason
      try {
        socket.send(JSON.stringify({ type: "unauthorized", reason }))
      } catch {
        // Ignore.
      }
      socket.close(1008, reason)
    }

    socket.on("message", (data: RawData) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      const type = message.type
      if (!authenticated) {
        if (type !== "hello") return
        if (typeof message.token !== "string" || !sameToken(this.token, message.token)) {
          reject("Código de conexión inválido.")
          return
        }
        authenticated = true
        this.browser = typeof message.browser === "string" ? message.browser : ""
        this.version = typeof message.version === "string" ? message.version : ""
        this.lastError = ""
        this.attachSocket(socket)
        try {
          socket.send(JSON.stringify({ type: "welcome" }))
        } catch {
          // Ignore.
        }
        // Ask for the current group after the handshake.
        void this.call("list", {}).then((result) => {
          const tabs = (result as { tabs?: unknown })?.tabs
          this.setTabs(parseTabs(tabs))
        }).catch(() => undefined)
        return
      }

      if (type === "tabs") {
        this.setTabs(parseTabs(message.tabs))
        return
      }
      if (type === "pong") {
        this.lastPong = Date.now()
        return
      }
      if (type === "result" && typeof message.id === "string") {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok === true) pending.resolve(message.result)
        else pending.reject(new Error(typeof message.error === "string" ? message.error : "Browser extension error."))
      }
    })

    socket.on("close", () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.rejectAll(new Error("[browser.extension] The browser extension disconnected."))
      this.tabs = []
      this.tabsListener?.([])
      if (!this.lastError) this.lastError = "La extensión se desconectó."
    })
    socket.on("error", () => {
      // The close handler cleans up.
    })
  }

  private attachSocket(socket: WebSocket): void {
    if (this.socket && this.socket !== socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1008, "Replaced by a new connection")
      } catch {
        // Ignore.
      }
    }
    this.socket = socket
    this.lastPong = Date.now()
    this.lastError = ""
  }

  private setTabs(tabs: BrowserTabInfo[]): void {
    this.tabs = tabs
    this.tabsListener?.(tabs)
  }

  private beat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastPong > HEARTBEAT_MS * HEARTBEAT_MISSES) {
      this.lastError = "La extensión dejó de responder."
      try {
        this.socket.terminate()
      } catch {
        // Ignore.
      }
      return
    }
    try {
      this.socket.ping()
    } catch {
      // Ignore.
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private tokenFile(): string {
    return path.join(this.dataDir, "browser-bridge.json")
  }

  private loadToken(): string {
    try {
      const file = this.tokenFile()
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }
        if (typeof data.token === "string" && data.token.length >= 8) return data.token
      }
    } catch {
      // Regenerate below.
    }
    const token = readableToken()
    this.saveToken(token)
    return token
  }

  private saveToken(token: string): void {
    try {
      writeFileSync(this.tokenFile(), JSON.stringify({ token }, null, 2), "utf8")
    } catch {
      // The token still works for this process.
    }
  }
}
