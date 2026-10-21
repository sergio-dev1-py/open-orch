/** Live check: OpenOrch bridge + the real Edge extension + the mock shop flow. */
import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { _electron as electron, chromium, type BrowserContext, type Worker } from "playwright-core"

const root = path.resolve(import.meta.dir, "..")
const base = path.join(root, ".data", "extension-live")
const dataDir = path.join(base, "userdata")
const workspace = path.join(base, "workspace")
const edgeProfile = path.join(base, "edge-profile")
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const extensionPath = path.join(process.env.USERPROFILE ?? "", "Desktop", "OpenOrch Browser Extension")
const port = 8788
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(step: string, value?: unknown): void {
  console.log(`[live] ${step}${value === undefined ? "" : `: ${typeof value === "string" ? value : JSON.stringify(value)}`}`)
}

const mock = spawn("bun", ["run", path.join(root, "scripts", "mock-provider.ts"), String(port)], { cwd: root, stdio: "ignore", shell: true })
await sleep(1_200)

rmSync(base, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "extension-live", version: "1.0.0" }, null, 2))
mkdirSync(dataDir, { recursive: true })
writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    {
      language: "es",
      configVersion: 2,
      providers: {
        mock: { kind: "openai-compatible", name: "Mock", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "mock-key", models: ["mock-model"], enabled: true },
      },
      codeMode: { enabled: true },
      browser: { mode: "extension" },
      lastDirectory: workspace,
    },
    null,
    2,
  ),
)

const app = await electron.launch({
  args: [path.join(root, "apps", "desktop")],
  cwd: root,
  env: {
    ...process.env,
    OPENORCH_DATA_DIR: dataDir,
    OPENORCH_DIR: workspace,
    OPENORCH_CONFIG_DIR: path.join(dataDir, "config"),
    OPENORCH_HOME: path.join(base, "home"),
  },
})
app.process().stdout?.on("data", (chunk) => console.log("[app]", String(chunk).trim()))
app.process().stderr?.on("data", (chunk) => console.log("[app:err]", String(chunk).trim()))
let edge: BrowserContext | undefined
try {
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1_500)
  if (await page.locator(".workspace-row").count()) {
    await page.locator(".workspace-row").first().click()
    await page.waitForTimeout(600)
  }
  const bridge = (await page.evaluate(() => window.openorch.invoke("browser.extensionInfo"))) as {
    port: number
    token: string
    connected: boolean
  }
  log("bridge ready", { port: bridge.port, token: bridge.token, connected: bridge.connected })

  const launchEdge = async (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(edgeProfile, {
      executablePath: edgePath,
      headless: false,
      viewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=msEdgeFirstRunExperience",
      ],
    })

  const findWorker = async (context: BrowserContext): Promise<Worker | undefined> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const worker = context.serviceWorkers().find((entry) => entry.url().startsWith("chrome-extension://"))
      if (worker) return worker
      await sleep(250)
    }
    return undefined
  }

  edge = await launchEdge()
  const firstWorker = await findWorker(edge)
  if (!firstWorker) throw new Error("The extension service worker never started.")
  log("extension worker", firstWorker.url())
  await firstWorker
    .evaluate(
      async ({ serverUrl, token }) => {
        await chrome.storage.local.set({ enabled: true, serverUrl, token })
      },
      { serverUrl: `ws://127.0.0.1:${bridge.port}`, token: bridge.token },
    )
    .catch(() => undefined)
  log("storage", await firstWorker.evaluate(() => chrome.storage.local.get(["enabled", "serverUrl", "token"])))
  await edge.close()
  await sleep(800)

  edge = await launchEdge()
  const worker = await findWorker(edge)
  if (!worker) throw new Error("The extension service worker did not restart.")
  log("extension restarted", worker.url())

  let status: { connected: boolean; tabs: { id: string; url: string; title: string }[]; lastError: string } | undefined
  for (let attempt = 0; attempt < 60; attempt++) {
    status = (await page.evaluate(() => window.openorch.invoke("browser.extensionInfo"))) as typeof status
    if (status?.connected) break
    await sleep(500)
  }
  log("extension connected", { connected: status?.connected, error: status?.lastError })
  if (!status?.connected) throw new Error(`The extension did not connect: ${status?.lastError ?? "unknown"}`)

  const tabId = (await worker.evaluate(async () => {
    const tab = await chrome.tabs.create({ url: "https://example.com/", active: false })
    const groupId = await chrome.tabs.group({ tabIds: [tab.id!] })
    await chrome.tabGroups.update(groupId, { title: "OpenOrch", color: "blue" })
    return tab.id
  })) as number
  log("test tab", tabId)
  await sleep(800)
  status = (await page.evaluate(() => window.openorch.invoke("browser.extensionInfo"))) as typeof status
  log("agent tabs", status?.tabs)
  if (!status?.tabs.some((tab) => tab.url.includes("example.com"))) throw new Error("The bridge did not see the test tab.")

  // Full agent flow through the extension.
  await page.click(".new-session").catch(() => undefined)
  await page.fill(".composer textarea", "Haz la compra de prueba en el navegador del dock")
  await page.keyboard.press("Enter")
  const asked = await page.waitForSelector(".dock.permission", { timeout: 30_000 }).then(() => true).catch(() => false)
  log("permission dialog", asked)
  if (asked) await page.click(".dock.permission button:has-text('Permitir siempre')", { timeout: 15_000 }).catch(() => undefined)

  const card = page.locator(".tool-card:has-text('Code Mode')").last()
  await card.waitFor({ timeout: 45_000 })
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll(".tool-card")].filter((node) => node.textContent?.includes("Code Mode"))
      return Boolean(cards.at(-1)?.textContent?.includes("tool calls"))
    },
    undefined,
    { timeout: 45_000 },
  )
  if ((await card.locator(".tool-body").count()) === 0) await card.locator(".tool-head").click().catch(() => undefined)
  await page.waitForTimeout(400)
  const text = await card.innerText()
  log("code mode result", text.replaceAll("\n", " | ").slice(-260))
  if (!text.includes("En el carrito: 2")) throw new Error("The agent did not complete the cart flow through the extension.")
  log("PASS cart")

  // Anti-bot gate: the tool must pause, let the user resolve it, and resume.
  await page.fill(".composer textarea", "Haz el reto de prueba en el navegador")
  await page.keyboard.press("Enter")
  const wizard = await page.waitForSelector(".question-wizard", { timeout: 45_000 }).catch(() => undefined)
  if (!wizard) {
    console.log("[live] page tail:", (await page.locator("body").innerText()).replaceAll("\n", " | ").slice(-1_200))
    throw new Error("The challenge did not trigger the handoff wizard.")
  }
  log("handoff wizard", (await wizard.innerText()).replaceAll("\n", " | ").slice(0, 220))

  let challengePage = edge.pages().find((candidate) => candidate.url().includes("/challenge"))
  if (!challengePage) {
    challengePage = await edge.waitForEvent("page", { timeout: 15_000 }).then((candidate) =>
      candidate.url().includes("/challenge") ? candidate : undefined,
    ).catch(() => undefined)
  }
  if (!challengePage) throw new Error("The Edge challenge page was not found.")
  await challengePage.click("#solve", { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.click(".question-option:has-text('Continuar')")
  await page.waitForTimeout(300)
  await page.click(".question-actions button:has-text('Enviar')")

  const challengeCard = page.locator(".tool-card:has-text('Code Mode')").last()
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll(".tool-card")].filter((node) => node.textContent?.includes("Code Mode"))
      return Boolean(cards.at(-1)?.textContent?.includes("tool calls"))
    },
    undefined,
    { timeout: 45_000 },
  )
  if ((await challengeCard.locator(".tool-body").count()) === 0) await challengeCard.locator(".tool-head").click().catch(() => undefined)
  await page.waitForTimeout(400)
  const challengeText = await challengeCard.innerText()
  log("handoff result", challengeText.replaceAll("\n", " | ").slice(-260))
  if (!challengeText.includes('"ok": true')) throw new Error("The agent did not resume after the handoff.")
  log("PASS handoff")

  log("PASS")
} finally {
  await Promise.race([edge?.close().catch(() => undefined), sleep(5_000)])
  await Promise.race([app.close(), sleep(5_000)]).catch(() => undefined)
  app.process().kill()
  mock.kill()
  setTimeout(() => process.exit(0), 500)
}
