/**
 * Bridge protocol checks with a fake extension (no Edge required).
 *
 *   bun run scripts/check-bridge.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { WebSocket } from "ws"
import { ExtensionBridge } from "../apps/desktop/src/main/browser-bridge"
import { ExtensionBrowser } from "../apps/desktop/src/main/extension-browser"

const root = path.resolve(import.meta.dir, "..")
const dataDir = path.join(root, ".data", "bridge-check")

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(url: string, token: string, origin = "chrome-extension://test"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, undefined, { headers: { Origin: origin } })
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", token, version: "0.1.0", browser: "Fake Edge/155" }))
      resolve(socket)
    })
    socket.once("error", reject)
  })
}

function answer(socket: WebSocket, id: string, result: unknown): void {
  socket.send(JSON.stringify({ type: "result", id, ok: true, result }))
}

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const bridge = new ExtensionBridge(dataDir)
const port = await bridge.start()
const browser = new ExtensionBrowser(bridge)
const url = `ws://127.0.0.1:${port}`

const unauthorized = new WebSocket(url, undefined, { headers: { Origin: "https://evil.example" } })
const rejected = await new Promise<boolean>((resolve) => {
  unauthorized.once("close", (code) => resolve(code === 1008))
  unauthorized.once("open", () => unauthorized.send(JSON.stringify({ type: "hello", token: bridge.info.token })))
  setTimeout(() => resolve(false), 2_000)
})
check("bridge: rejects non-extension origins", rejected)

const preAuth = new WebSocket(url, undefined, { headers: { Origin: "chrome-extension://test" } })
const preAuthTabs = await new Promise<unknown>((resolve) => {
  preAuth.once("open", () => preAuth.send(JSON.stringify({ type: "tabs", tabs: [] })))
  preAuth.once("message", (data) => resolve(JSON.parse(data.toString())))
  setTimeout(() => resolve(undefined), 1_000)
})
preAuth.close()
check("bridge: ignores messages before hello", preAuthTabs === undefined)

const socket = await connect(url, "ORCH-WRONG-CODE")
const rejectedToken = await new Promise<boolean>((resolve) => {
  socket.once("close", (code) => resolve(code === 1008))
  setTimeout(() => resolve(false), 2_000)
})
check("bridge: rejects a wrong pairing code", rejectedToken)

const good = await connect(url, bridge.info.token)
const calls: string[] = []
good.on("message", (data) => {
  const message = JSON.parse(data.toString()) as { type: string; id?: string; op?: string; args?: Record<string, unknown> }
  if (message.type === "tabs") return
  if (message.type !== "call" || !message.id) return
  const op = message.op || ""
  calls.push(op)
  if (op === "list") {
    answer(good, message.id, { tabs: [{ id: "edge:1", url: "https://example.com", title: "Example" }] })
  } else if (op === "open") {
    answer(good, message.id, { tab: { id: "edge:2", url: "https://shop.test/", title: "Shop" } })
  } else if (op === "snapshot") {
    answer(good, message.id, {
      tab: { id: "edge:2", url: "https://shop.test/", title: "Shop" },
      tree: '- button "Buy now" [ref=e1]',
      truncated: false,
      text: "",
    })
  } else if (op === "click") {
    answer(good, message.id, { tab: { id: "edge:2", url: "https://shop.test/cart", title: "Cart" } })
  } else if (op === "evaluate") {
    answer(good, message.id, {
      tab: { id: "edge:2", url: "https://shop.test/cart", title: "Cart" },
      value: { kind: "challenge", evidence: "just a moment", title: "Just a moment...", url: "https://shop.test/" },
    })
  } else if (op === "wait") {
    answer(good, message.id, { tab: { id: "edge:2", url: "https://shop.test/", title: "Shop" }, matched: true })
  } else {
    answer(good, message.id, { tab: { id: "edge:2", url: "https://shop.test/", title: "Shop" } })
  }
})

await sleep(300)
good.send(JSON.stringify({ type: "tabs", tabs: [{ id: "edge:1", url: "https://example.com", title: "Example" }] }))
await sleep(200)
check("bridge: extension hello is accepted", bridge.connected)
check("bridge: tab cache reaches ExtensionBrowser", browser.list()[0]?.id === "edge:1", browser.list()[0]?.id)

const opened = await browser.open("https://shop.test/")
check("bridge: high-level open round-trips", opened.id === "edge:2" && opened.title === "Shop", `${opened.id} ${opened.title}`)

const snapshot = await browser.snapshot("edge:2")
check("bridge: snapshot round-trips", snapshot.tree.includes("Buy now"))

const clicked = await browser.click("edge:2", "@e1")
check("bridge: click round-trips", clicked.url === "https://shop.test/cart")

const evaluated = await browser.evaluate("edge:2", "1+1")
check("bridge: evaluate returns the extension value", (evaluated.value as { kind?: string })?.kind === "challenge")

const waited = await browser.wait("edge:2", { text: "Shop", timeoutMs: 1000 })
check("bridge: wait round-trips", waited.matched === true)

const callLog = calls.join(",")
check("bridge: list is requested after hello", callLog.includes("list"), callLog.slice(0, 80))

good.close()
await sleep(300)
check("bridge: disconnect clears the cache", browser.list().length === 0)
let failed = false
try {
  await browser.open("https://example.com")
} catch {
  failed = true
}
check("bridge: calls fail clearly while disconnected", failed)

bridge.dispose()

const failedChecks = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failedChecks.length}/${results.length} bridge checks passed`)
if (failedChecks.length > 0) process.exitCode = 1
