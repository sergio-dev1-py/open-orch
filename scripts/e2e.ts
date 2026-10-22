/**
 * End-to-end smoke test for OpenOrch.
 *
 * Covers: streaming chat, tool cards + diffs, plan-mode denial, wide content and
 * scroll safety, all themes, delete confirmation, SQLite persistence, worktrees
 * through Code Mode `execute`.
 *
 * Usage:
 *   1. bun run --cwd apps/desktop build
 *   2. bun run scripts/e2e.ts
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { _electron as electron, type ElectronApplication } from "playwright-core"

const root = path.resolve(import.meta.dir, "..")
const dataDir = path.join(root, ".data", "e2e", "userdata")
const workspace = path.join(root, ".data", "e2e", "workspace")
const homeDir = path.join(root, ".data", "e2e", "home")
const shotsDir = path.join(root, ".data", "e2e", "shots")
const port = 8788
const remoteMcpPort = 8799

let mock: ChildProcess | undefined
let remoteMcp: ChildProcess | undefined
let appHandle: ElectronApplication | undefined

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

async function startMock(): Promise<void> {
  mock = spawn("bun", ["run", path.join(root, "scripts", "mock-provider.ts"), String(port)], {
    cwd: root,
    stdio: "ignore",
    shell: true,
  })
  // Remote MCP server with OAuth (401 → sign-in flow) for the MCP checks.
  remoteMcp = spawn("bun", ["run", path.join(root, "scripts", "mock-mcp-remote.ts"), String(remoteMcpPort)], {
    cwd: root,
    stdio: "ignore",
    shell: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

/** Writes a minimal skill (`SKILL.md`) under a compatibility root. */
function seedSkill(base: string, id: string, description: string, extra = ""): void {
  mkdirSync(path.join(base, id), { recursive: true })
  writeFileSync(
    path.join(base, id, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n${extra}---\n\nSaluda diciendo HOLA-${id.toUpperCase()}.\n`,
  )
}

function seedEnvironment(): void {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "e2e-workspace", version: "1.0.0" }, null, 2))
  writeFileSync(path.join(workspace, "index.ts"), "export const hello = 'world'\n")
  // A file outside the workspace: reading it must ask for permission.
  writeFileSync(path.join(root, ".data", "e2e", "outside.txt"), "archivo fuera del workspace\n")
  // A skill installed in the workspace (also exercises global/project discovery).
  mkdirSync(path.join(workspace, ".opencode", "skills", "e2e-skill"), { recursive: true })
  writeFileSync(
    path.join(workspace, ".opencode", "skills", "e2e-skill", "SKILL.md"),
    `---\nname: E2E Skill\ndescription: Skill de prueba para el e2e\n---\n\nSaluda diciendo HOLA-SKILL.\n`,
  )
  // Compatibility roots (what `npx skills add` and Claude Code use): global `~/.agents` and
  // `~/.claude`, plus the project `.agents` folder.
  seedSkill(path.join(homeDir, ".agents", "skills"), "e2e-agents-skill", "Skill global instalada por npx skills", "license: MIT\n")
  seedSkill(path.join(homeDir, ".claude", "skills"), "e2e-claude-skill", "Skill global de Claude Code")
  seedSkill(path.join(workspace, ".agents", "skills"), "e2e-project-agents", "Skill del proyecto instalada por npx skills")
  // Project-scoped MCP server (committed with the repo): `.openorch/mcp.json`.
  mkdirSync(path.join(workspace, ".openorch"), { recursive: true })
  writeFileSync(
    path.join(workspace, ".openorch", "mcp.json"),
    JSON.stringify(
      { projectmcp: { type: "local", command: ["bun", "run", path.join(root, "scripts", "mock-mcp.ts")], enabled: true } },
      null,
      2,
    ),
  )
  git(["init"], workspace)
  git(["-c", "user.email=e2e@openorch.local", "-c", "user.name=OpenOrch E2E", "add", "-A"], workspace)
  git(["-c", "user.email=e2e@openorch.local", "-c", "user.name=OpenOrch E2E", "commit", "-m", "init"], workspace)

  const config = {
    language: "es",
    theme: "light",
    configVersion: 2,
    providers: {
      mock: {
        kind: "openai-compatible",
        name: "Mock Provider",
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "mock-key",
        models: ["mock-model"],
        enabled: true,
      },
      // Catalog provider (real variants + reasoning families) pointed at the mock
      // so variant/reasoning behaviour can be verified end to end.
      opencode: {
        apiKey: "mock-key",
        baseURL: `http://127.0.0.1:${port}/v1`,
        enabled: true,
      },
    },
    // No default model on purpose: OpenOrch must pick the cheapest available and,
    // once a model is used, remember it per directory / globally.
    codeMode: { enabled: true },
    lastDirectory: workspace,
    // Local MCP server for the status button checks (stdio JSON-RPC mock).
    mcp: {
      mockmcp: { type: "local", command: ["bun", "run", path.join(root, "scripts", "mock-mcp.ts")], enabled: true },
    },
  }
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2))
}

async function main(): Promise<void> {
  mkdirSync(shotsDir, { recursive: true })
  await startMock()
  seedEnvironment()

  const app = await electron.launch({
    args: [path.join(root, "apps", "desktop")],
    cwd: root,
    env: {
      ...process.env,
      OPENORCH_DATA_DIR: dataDir,
      OPENORCH_DIR: workspace,
      // Sandbox the global OpenOrch folder (skills installed by `/skill`).
      OPENORCH_CONFIG_DIR: path.join(dataDir, "config"),
      // Sandbox the user home: compatibility roots (`~/.agents`, `~/.claude`) live here.
      OPENORCH_HOME: homeDir,
      // MCP OAuth: complete the sign-in flow without opening a real browser.
      OPENORCH_MCP_AUTH_AUTO: "1",
      // Scheduled task tests must not create OS toasts or Windows login items.
      OPENORCH_DISABLE_NOTIFICATIONS: "1",
      OPENORCH_DISABLE_LOGIN_ITEM: "1",
      // Live models.dev catalog served by the mock (deterministic tests).
      OPENORCH_MODELS_URL: `http://127.0.0.1:${port}/models-dev.json`,
      // OpenCode Console account config served by the mock.
      OPENORCH_CONSOLE_URL: `http://127.0.0.1:${port}/console-config.json`,
    },
  })
  appHandle = app
  const page = await app.firstWindow()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.waitForLoadState("domcontentloaded")
  // Electron userData (localStorage) is shared between runs: start with a fresh dock
  // layout so tab counts are deterministic (the store reads it at module init).
  await page.evaluate(() => localStorage.removeItem("openorch.dock.v1")).catch(() => undefined)
  await page.reload()
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(shotsDir, "01-initial.png") })

  const composer = page.locator(".composer textarea")

  // ---------------------------------------------------------------- workspace picker
  check("workspace: startup shows the folder picker", (await page.locator(".workspace-screen").count()) === 1)
  const workspaceRow = page.locator(".workspace-row").first()
  check("workspace: picker lists the last used folder", (await workspaceRow.count()) >= 1)

  // Settings must be reachable from the picker (bottom-left button).
  await page.click(".workspace-settings")
  await page.waitForSelector(".modal", { timeout: 10_000 })
  check("workspace: settings open from the picker", (await page.locator(".modal-nav button:has-text('General')").count()) >= 1)
  await page.click(".modal-close")
  await page.waitForTimeout(300)

  // Drag & drop wiring: synthesized files have no real path and must be rejected.
  const emptyPath = await page.evaluate(() => window.openorch.pathForFile(new File(["x"], "x.txt")))
  check("workspace: dropped files without a real path are rejected", emptyPath === "", `path="${emptyPath}"`)
  const isDirectory = await page.evaluate(
    async (target) => window.openorch.invoke("path.isDirectory", target as string),
    workspace,
  )
  check("workspace: path.isDirectory validates dropped folders", isDirectory === true)
  await page.evaluate(() => {
    const screen = document.querySelector(".workspace-screen")
    if (!screen) return
    const transfer = new DataTransfer()
    transfer.items.add(new File(["x"], "nota.txt", { type: "text/plain" }))
    screen.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }))
    screen.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await page.waitForTimeout(400)
  const dropError = await page.locator(".workspace-error").innerText().catch(() => "")
  check("workspace: dropping a file shows a friendly error", dropError.toLowerCase().includes("carpeta"), dropError.replaceAll("\n", " | ").slice(0, 80))

  await workspaceRow.click()
  await page.waitForTimeout(700)
  const chipName = await page.locator(".workspace-entry.active .workspace-entry-name").innerText().catch(() => "")
  check("workspace: entering shows the folder chip", chipName.trim() === path.basename(workspace), chipName)
  check("workspace: only this folder's sessions are listed", (await page.locator(".session-item").count()) === 0)
  // Sessions from other folders must stay out of this workspace's list.
  await page.evaluate(async (other) => {
    await window.openorch.invoke("sessions.create", { directory: other as string })
  }, path.join(root, ".data", "e2e", "other-workspace"))
  await page.waitForTimeout(600)
  check("workspace: sessions from other folders stay hidden", (await page.locator(".session-item").count()) === 0)
  await page.screenshot({ path: path.join(shotsDir, "01b-workspace.png") })

  // ---------------------------------------------------------------- sidebar collapse + workspace tree
  check("sidebar: the active workspace is marked in the tree", (await page.locator(".workspace-entry.active").count()) === 1)
  check("sidebar: known workspaces are listed", (await page.locator(".workspace-entry").count()) >= 2, `${await page.locator(".workspace-entry").count()} entries`)
  await page.click(".sidebar-header .brand .icon-button")
  await page.waitForTimeout(400)
  check(
    "sidebar: collapsing hides it and shows the reopen button",
    (await page.locator(".app.no-sidebar").count()) === 1 && (await page.locator("button[title='Mostrar barra lateral']").count()) === 1,
  )
  const storedSidebar = await page.evaluate(() => localStorage.getItem("openorch.sidebar"))
  check("sidebar: collapsed state is remembered", storedSidebar === "collapsed", String(storedSidebar))
  await page.click("button[title='Mostrar barra lateral']")
  await page.waitForTimeout(400)
  check("sidebar: reopening restores it", (await page.locator(".app.no-sidebar").count()) === 0 && (await page.locator(".sidebar").count()) === 1)
  check("sidebar: the active workspace is expanded with its sessions area", (await page.locator(".workspace-entry.active + .workspace-sessions").count()) === 1)

  // ---------------------------------------------------------------- MCP status button
  {
    await page.waitForSelector(".mcp-button", { timeout: 10_000 })
    await page
      .waitForFunction(() => document.querySelector(".mcp-button")?.textContent?.includes("Conectado") ?? false, undefined, {
        timeout: 20_000,
      })
      .catch(() => undefined)
    const mcpText = await page.locator(".mcp-button").innerText()
    check(
      "mcp: the sidebar button shows the connected server",
      mcpText.includes("MCP") && mcpText.includes("Conectado"),
      mcpText.replaceAll("\n", " | ").slice(0, 60),
    )
    check("mcp: the indicator is green", (await page.locator(".mcp-button .status-dot.ok").count()) === 1)
    await page.click(".mcp-button")
    await page.waitForSelector(".modal", { timeout: 5_000 })
    const activeSettingsTab = (await page.locator(".modal-nav button.active").innerText()).trim()
    check("mcp: the button opens Settings on the MCP tab", activeSettingsTab === "MCP", activeSettingsTab)
    const mcpTabText = await page.locator(".modal-body").innerText()
    check(
      "mcp: the tab lists the server and its status",
      mcpTabText.includes("mockmcp") && mcpTabText.includes("connected") && mcpTabText.includes("1 tools"),
      mcpTabText.replaceAll("\n", " | ").slice(0, 90),
    )
    // The tool list is collapsed by default (a server can expose hundreds of tools).
    await page.click(".modal-body .mcp-tools summary")
    const mcpToolsText = await page.locator(".modal-body .mcp-tools-list").first().innerText()
    check("mcp: expanding the summary shows the tool names", mcpToolsText.includes("echo"), mcpToolsText.slice(0, 60))
    await page.click(".modal-close")
    await page.waitForTimeout(300)
    // A broken server turns the indicator red (errors win over connected).
    await page.evaluate(() =>
      window.openorch.invoke("config.set", {
        mcp: { brokenserver: { type: "local", command: ["definitely-not-a-real-command-xyz"], enabled: true } },
      }),
    )
    await page
      .waitForFunction(() => document.querySelector(".mcp-button")?.textContent?.includes("Error") ?? false, undefined, {
        timeout: 20_000,
      })
      .catch(() => undefined)
    const brokenText = await page.locator(".mcp-button").innerText()
    check(
      "mcp: a broken server turns the indicator red",
      brokenText.includes("Error") && (await page.locator(".mcp-button .status-dot.err").count()) === 1,
      brokenText.replaceAll("\n", " | ").slice(0, 60),
    )
    // Disabling every server hides the indicator again.
    await page.evaluate(() =>
      window.openorch.invoke("config.set", { mcp: { mockmcp: { enabled: false }, brokenserver: { enabled: false } } }),
    )
    await page.waitForTimeout(2500)
    const clearedText = await page.locator(".mcp-button").innerText()
    check(
      "mcp: without enabled servers the button shows no indicator",
      !clearedText.includes("Conectado") && !clearedText.includes("Error"),
      clearedText.replaceAll("\n", " | ").slice(0, 60),
    )
    // Restore the working server for the rest of the suite.
    await page.evaluate(() =>
      window.openorch.invoke("config.set", { mcp: { mockmcp: { enabled: true }, brokenserver: { enabled: false } } }),
    )
    await page.waitForTimeout(1500)

    // Project-scoped servers come from the workspace's `.openorch/mcp.json`: pointing the
    // engine at the workspace loads that project's servers (the sidebar click does the same).
    await page.evaluate((directory) => window.openorch.invoke("config.set", { lastDirectory: directory }), workspace)
    let projectEntry: { name: string; status: string; scope: string } | undefined
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = (await page.evaluate(() => window.openorch.invoke("mcp.status"))) as {
        name: string
        status: string
        scope: string
      }[]
      projectEntry = status.find((entry) => entry.name === "projectmcp")
      if (projectEntry?.status === "connected") break
      await page.waitForTimeout(500)
    }
    check(
      "mcp: project servers connect from .openorch/mcp.json",
      projectEntry?.status === "connected" && projectEntry?.scope === "project",
      JSON.stringify(projectEntry ?? {}).slice(0, 80),
    )
    await page.click(".mcp-button")
    await page.waitForSelector(".modal", { timeout: 5_000 })
    const projectRow = await page.locator(".modal-body .provider-row:has-text('projectmcp')").innerText()
    check("mcp: Settings marks project servers", projectRow.includes("proyecto") || projectRow.includes("project"), projectRow.replaceAll("\n", " | ").slice(0, 80))

    // Remote server that requires OAuth: needs-auth → amber badge → sign in → connected.
    await page.evaluate((url) => window.openorch.invoke("config.set", { mcp: { remotemcp: { type: "remote", url, enabled: true } } }), `http://127.0.0.1:${remoteMcpPort}/mcp`)
    let remoteStatus: { name: string; status: string } | undefined
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = (await page.evaluate(() => window.openorch.invoke("mcp.status"))) as { name: string; status: string }[]
      remoteStatus = status.find((entry) => entry.name === "remotemcp")
      if (remoteStatus?.status === "needs-auth") break
      await page.waitForTimeout(500)
    }
    check("mcp: a remote server that requires OAuth becomes needs-auth", remoteStatus?.status === "needs-auth", remoteStatus?.status ?? "missing")
    await page.waitForTimeout(300)
    const amberText = await page.locator(".mcp-button").innerText()
    check(
      "mcp: the sidebar shows the amber sign-in state",
      amberText.includes("login") && (await page.locator(".mcp-button .status-dot.auth").count()) === 1,
      amberText.replaceAll("\n", " | ").slice(0, 60),
    )
    await page.click(".modal-body .provider-row:has-text('remotemcp') button:has-text('Iniciar sesión')")
    let signedIn: { name: string; status: string; toolNames?: string[] } | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = (await page.evaluate(() => window.openorch.invoke("mcp.status"))) as {
        name: string
        status: string
        toolNames?: string[]
      }[]
      signedIn = status.find((entry) => entry.name === "remotemcp")
      // The server can report "connected" before the tool list is published.
      if (signedIn?.status === "connected" && (signedIn?.toolNames ?? []).includes("echo")) break
      await page.waitForTimeout(500)
    }
    check(
      "mcp: signing in connects the server with its tools",
      signedIn?.status === "connected" && (signedIn?.toolNames ?? []).includes("echo"),
      JSON.stringify(signedIn ?? {}).slice(0, 90),
    )
    check("mcp: OAuth tokens are stored in mcp-auth.json", existsSync(path.join(dataDir, "mcp-auth.json")))
    const greenAgain = await page.locator(".mcp-button").innerText()
    check("mcp: the sidebar goes back to green after signing in", greenAgain.includes("Conectado"), greenAgain.replaceAll("\n", " | ").slice(0, 60))
    await page.click(".modal-close")
    await page.waitForTimeout(300)
  }
  // Switching to another workspace expands it (and hides the previous one).
  await page.evaluate((directory) => {
    const entry = [...document.querySelectorAll<HTMLElement>(".workspace-entry")].find((node) => node.dataset.directory === directory)
    entry?.click()
  }, path.join(root, ".data", "e2e", "other-workspace"))
  await page.waitForTimeout(900)
  const otherActive = await page.locator(".workspace-entry.active").getAttribute("data-directory")
  check("sidebar: the clicked workspace becomes active", otherActive?.endsWith("other-workspace") === true, otherActive ?? "none")
  check("sidebar: the active workspace shows its sessions", (await page.locator(".workspace-sessions .session-item").count()) >= 1)
  await page.evaluate((directory) => {
    const entry = [...document.querySelectorAll<HTMLElement>(".workspace-entry")].find((node) => node.dataset.directory === directory)
    entry?.click()
  }, workspace)
  await page.waitForTimeout(900)
  const backActive = await page.locator(".workspace-entry.active").getAttribute("data-directory")
  check("sidebar: switching back re-expands the main workspace", backActive === workspace, backActive ?? "none")

  // ---------------------------------------------------------------- session + write
  await page.click("text=Nueva sesión")
  await page.waitForTimeout(400)
  await composer.fill("Escribe un archivo MOCK_NOTES.md con las notas")
  await page.keyboard.press("Enter")
  await page.waitForSelector("text=MOCK_NOTES.md", { timeout: 30_000 })
  await page.waitForTimeout(1000)
  check("chat: tool card appears", true)
  await page.click(".tool-card .tool-head")
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(shotsDir, "02-diff.png") })
  const diffOk = await page.locator(".diff-line.add").count()
  check("chat: diff renders added lines", diffOk > 0, `${diffOk} lines`)

  // ---------------------------------------------------------------- wide content / scroll
  await composer.fill("Dame una respuesta ancho con tabla y codigo")
  await page.keyboard.press("Enter")
  await page.waitForSelector("text=Columna extremadamente larga", { timeout: 30_000 })
  await page.waitForSelector(".code-block .shiki", { timeout: 15_000 })
  await page.waitForTimeout(800)
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    const inner = document.querySelector(".timeline-inner") as HTMLElement | null
    const timeline = document.querySelector(".timeline") as HTMLElement | null
    return {
      root: root.scrollWidth - root.clientWidth,
      inner: inner && timeline ? inner.scrollWidth - timeline.clientWidth : 0,
    }
  })
  check("scroll: window has no horizontal overflow", overflow.root <= 1, `delta=${overflow.root}`)
  check("scroll: timeline content fits", overflow.inner <= 2, `delta=${overflow.inner}`)
  const codeScroll = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll(".code-block .shiki")] as HTMLElement[]
    const widest = blocks
      .map((block) => ({ scrollWidth: block.scrollWidth, clientWidth: block.clientWidth, overflowX: getComputedStyle(block).overflowX }))
      .sort((a, b) => b.scrollWidth - b.clientWidth - (a.scrollWidth - a.clientWidth))[0]
    return widest
  })
  check(
    "scroll: wide code block scrolls inside its box",
    Boolean(codeScroll && codeScroll.scrollWidth > codeScroll.clientWidth && codeScroll.overflowX === "auto"),
    codeScroll ? `scroll=${codeScroll.scrollWidth} client=${codeScroll.clientWidth} overflow-x=${codeScroll.overflowX}` : "missing .shiki",
  )
  // With no pending docks, the timeline must reach the composer's edge: the content is
  // clipped at the composer line, never before it.
  const edgeGap = await page.evaluate(() => {
    const timeline = document.querySelector(".timeline") as HTMLElement | null
    const composerWrap = document.querySelector(".composer-wrap") as HTMLElement | null
    if (!timeline || !composerWrap) return -1
    return Math.round(composerWrap.getBoundingClientRect().top - timeline.getBoundingClientRect().bottom)
  })
  check("scroll: timeline reaches the composer edge (no dead strip)", Math.abs(edgeGap) <= 1, `gap=${edgeGap}px`)
  await page.screenshot({ path: path.join(shotsDir, "03-wide.png") })

  // ---------------------------------------------------------------- themes
  for (const theme of ["light", "dark", "nord", "gruvbox", "tokyo"]) {
    await page.evaluate(async (value) => {
      await window.openorch.invoke("config.set", { theme: value })
    }, theme)
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(shotsDir, `theme-${theme}.png`) })
  }
  const themeApplied = await page.evaluate(() => document.documentElement.dataset.theme)
  check("themes: all 5 apply", themeApplied === "tokyo", `current=${themeApplied}`)
  await page.evaluate(async () => {
    await window.openorch.invoke("config.set", { theme: "light" })
  })
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- code mode + worktrees
  await composer.fill("Usa codemode para crear un worktree")
  await page.keyboard.press("Enter")
  try {
    await page.waitForSelector("text=Code Mode", { timeout: 30_000 })
  } catch (error) {
    console.log("--- timeline text on failure ---")
    console.log(await page.locator(".timeline").innerText())
    throw error
  }
  await page.waitForTimeout(1500)
  await page.click(".tool-card:has-text('Code Mode') .tool-head")
  await page.waitForTimeout(600)
  const callRows = await page.locator(".execute-call").count()
  check("codemode: nested tool calls listed", callRows >= 2, `${callRows} calls`)
  const worktreesRoot = path.join(workspace, ".openorch", "worktrees")
  const worktreeCreated = existsSync(worktreesRoot) && readdirSync(worktreesRoot).length > 0
  check("worktrees: directory created on disk", worktreeCreated, worktreesRoot)
  await page.screenshot({ path: path.join(shotsDir, "04-codemode.png") })

  // ---------------------------------------------------------------- parallel subagents
  await composer.fill("Lanza dos subagentes en paralelo para explorar el proyecto")
  await page.keyboard.press("Enter")
  await page.waitForSelector("text=Explorar el repositorio", { timeout: 30_000 })
  await page.waitForTimeout(4000)
  const subagentCards = await page.locator(".tool-card:has-text('Subagente')").count()
  check("subagents: two parallel calls in one step", subagentCards >= 2, `${subagentCards} cards`)
  const completedSubagents = await page.locator(".tool-card:has-text('Subagente') .tool-status").count()
  check("subagents: tool cards reported", completedSubagents >= 2, `${completedSubagents} statuses`)
  await page.screenshot({ path: path.join(shotsDir, "05-subagents.png") })
  {
    const db = new Database(path.join(dataDir, "openorch.db"), { readonly: true })
    const roots = (
      db.query("SELECT COUNT(*) AS c FROM session WHERE parent_id IS NULL AND directory = ?").get(workspace) as { c: number }
    ).c
    db.close()
    const listed = await page.locator(".session-item").count()
    check("subagents: child sessions are hidden from the sidebar", listed === roots, `${listed} listed of ${roots} roots`)
  }

  // ---------------------------------------------------------------- reasoning replay
  await composer.fill("Piensa paso a paso antes de responder")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".reasoning", { timeout: 30_000 })
  const reasoningText = await page.locator(".reasoning").first().innerText()
  check("reasoning: thinking block rendered", reasoningText.toLowerCase().includes("pensando") || reasoningText.toLowerCase().includes("pensamiento") || reasoningText.length > 0, reasoningText.slice(0, 40))
  await page.screenshot({ path: path.join(shotsDir, "06-reasoning.png") })
  await page.waitForTimeout(1500)

  // ---------------------------------------------------------------- SQLite
  const dbFile = path.join(dataDir, "openorch.db")
  check("sqlite: database file created", existsSync(dbFile))
  if (existsSync(dbFile)) {
    const db = new Database(dbFile, { readonly: true })
    const sessions = db.query("SELECT COUNT(*) AS c FROM session").get() as { c: number }
    const messages = db.query("SELECT COUNT(*) AS c FROM message").get() as { c: number }
    const children = db
      .query("SELECT id, parent_id, agent, model FROM session WHERE parent_id IS NOT NULL")
      .all() as { id: string; parent_id: string; agent: string; model: string }[]
    const parentModel =
      children.length > 0
        ? ((db.query("SELECT model FROM session WHERE id = ?").get(children[0].parent_id) as { model?: string } | null)?.model ?? undefined)
        : undefined
    const parseModel = (value: string | undefined) => {
      try {
        return JSON.parse(value ?? "{}") as { providerID?: string; modelID?: string; variant?: string }
      } catch {
        return {}
      }
    }
    const parentRef = parseModel(parentModel)
    const synthetics = db.query("SELECT data FROM message WHERE role = 'synthetic'").all() as { data: string }[]
    db.close()
    check("sqlite: sessions persisted", sessions.c >= 1, `${sessions.c} sessions`)
    check("sqlite: messages persisted", messages.c >= 4, `${messages.c} messages`)
    check("subagents: child sessions persisted", children.length >= 2, `${children.length} children`)
    check(
      "subagents: children use the parent's model (with the minimal variant)",
      children.length > 0 &&
        parentRef.providerID !== undefined &&
        children.every((child) => {
          const childRef = parseModel(child.model)
          return childRef.providerID === parentRef.providerID && childRef.modelID === parentRef.modelID
        }),
      `parent=${parentRef.providerID}/${parentRef.modelID} children=${children.map((child) => parseModel(child.model).variant ?? "-").join(", ")}`.slice(0, 140),
    )
  }

  // ---------------------------------------------------------------- plan mode denial
  await page.click(".composer-chip:has-text('Build')")
  await page.waitForTimeout(300)
  await page.click(".popover-item:has-text('Plan')")
  await page.waitForTimeout(400)
  await composer.fill("Escribe otro archivo PLAN_BLOCKED.md por favor")
  await page.keyboard.press("Enter")
  const denied = await page
    .waitForSelector("text=Cannot use write to modify files outside the Plan directory", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check("plan mode: edits denied", denied)
  const timelineText = await page.locator(".timeline").innerText()
  check(
    "plan mode: mode-switch notice is not shown in the chat",
    !timelineText.includes("system-reminder") && !timelineText.includes("You are in Plan mode"),
    timelineText.includes("system-reminder") ? "notice visible" : "hidden",
  )
  // The reminder is still persisted for the model, just hidden from the UI.
  {
    const db = new Database(dbFile, { readonly: true })
    const synthetics = db.query("SELECT data FROM message WHERE role = 'synthetic'").all() as { data: string }[]
    db.close()
    check(
      "plan mode: reminder still persisted for the model",
      synthetics.some((entry) => entry.data.includes('"source":"plan"')),
      `${synthetics.length} synthetic messages`,
    )
  }
  await page.screenshot({ path: path.join(shotsDir, "05-plan-denied.png") })
  await page.click(".composer-chip:has-text('Plan')")
  await page.waitForTimeout(300)
  await page.click(".popover-item:has-text('Build')")
  await page.waitForTimeout(300)

  // ---------------------------------------------------------------- question wizard
  await composer.fill("Hazme preguntas para configurar el proyecto")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".question-wizard", { timeout: 30_000 })
  const tabs = await page.locator(".question-tab").count()
  check("questions: wizard renders tabs plus submit", tabs === 4, `${tabs} tabs`)
  await page.click(".question-option:has-text('FastAPI')")
  await page.waitForTimeout(150)
  const singleSelected = await page.locator(".question-option.selected").count()
  check("questions: single choice selects exactly one option", singleSelected === 1, `${singleSelected} selected`)
  await page.waitForTimeout(500)
  const activeTab = (await page.locator(".question-tab.active").first().innerText()).trim()
  check("questions: single choice advances automatically", activeTab.startsWith("2"), `active=${activeTab}`)

  // Multiple selection keeps several options checked.
  await page.click(".question-option:has-text('Autenticación')")
  await page.click(".question-option:has-text('Carrito de compras')")
  await page.waitForTimeout(150)
  const multiSelected = await page.locator(".question-option.selected").count()
  check("questions: multiple choice allows several options", multiSelected === 2, `${multiSelected} selected`)

  // Back navigation returns to the previous question; single-choice stays single.
  await page.click(".question-actions button:has-text('Atrás')")
  await page.waitForTimeout(300)
  const backTab = (await page.locator(".question-tab.active").first().innerText()).trim()
  check("questions: back returns to the previous question", backTab.startsWith("1"), `active=${backTab}`)
  await page.click(".question-option:has-text('Flask')")
  await page.waitForTimeout(150)
  const afterChange = await page.locator(".question-option.selected").count()
  check("questions: changing a single choice replaces the selection", afterChange === 1, `${afterChange} selected`)
  await page.waitForTimeout(500)
  await page.locator(".question-tab").nth(1).click()
  await page.waitForTimeout(200)
  await page.locator(".question-tab").nth(2).click()
  await page.waitForTimeout(200)
  await page.click(".question-option:has-text('Español')")
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(shotsDir, "07-questions.png") })
  await page.click(".question-actions button:has-text('Enviar')")
  await page.waitForTimeout(2000)
  const wizardGone = (await page.locator(".question-wizard").count()) === 0
  check("questions: submitting closes the wizard", wizardGone)
  const questionCard = await page.locator(".tool-card:has-text('Preguntas al usuario')").count()
  check("questions: tool card recorded", questionCard >= 1, `${questionCard} cards`)

  // ---------------------------------------------------------------- composer layout (one line + send at right)
  await composer.fill("")
  await page.waitForTimeout(250)
  const emptyBox = await composer.boundingBox()
  check("composer: single-line height when empty", !!emptyBox && emptyBox.height <= 44, `height=${emptyBox ? Math.round(emptyBox.height) : "-"}`)
  await composer.type("Línea uno")
  await page.keyboard.press("Shift+Enter")
  await composer.type("Línea dos")
  await page.waitForTimeout(300)
  const grownBox = await composer.boundingBox()
  check(
    "composer: grows when a new line is added",
    !!grownBox && !!emptyBox && grownBox.height > emptyBox.height + 8,
    `empty=${emptyBox ? Math.round(emptyBox.height) : "-"} grown=${grownBox ? Math.round(grownBox.height) : "-"}`,
  )
  await composer.fill("")
  await page.waitForTimeout(250)
  const sendBox = await page.locator(".send-button").boundingBox()
  const composerBox = await page.locator(".composer-box").boundingBox()
  const attachChipBox = await page.locator(".composer-chip[title='Adjuntar imagen']").boundingBox()
  check(
    "composer: send button pinned to the right edge",
    !!sendBox &&
      !!composerBox &&
      !!attachChipBox &&
      Math.abs(composerBox.x + composerBox.width - (sendBox.x + sendBox.width)) < 26 &&
      sendBox.x > attachChipBox.x + attachChipBox.width,
    `composerRight=${composerBox ? Math.round(composerBox.x + composerBox.width) : "-"} sendRight=${sendBox ? Math.round(sendBox.x + sendBox.width) : "-"}`,
  )

  // ---------------------------------------------------------------- mentions (@) + skills
  await composer.fill("@e2e")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const mentionText = await page.locator(".suggestions").innerText()
  check("mentions: @ menu lists installed skills", mentionText.includes("e2e-skill"), mentionText.replaceAll("\n", " | ").slice(0, 90))
  await page.click(".suggestion:has-text('e2e-skill')")
  await page.waitForTimeout(300)
  const skillChip = await page.locator(".composer-attachment:has-text('e2e-skill')").count()
  check("mentions: selecting a skill attaches it as a chip", skillChip >= 1)
  await composer.fill("Usa la skill adjunta, por favor")
  await page.keyboard.press("Enter")
  const skillInjected = await page
    .waitForSelector("text=Skill: E2E Skill", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check("skills: mentioned skill is injected as <skill_content>", skillInjected)
  await page.screenshot({ path: path.join(shotsDir, "10-mentions.png") })
  await composer.fill("@")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const allMentions = await page.locator(".suggestions").innerText()
  check(
    "mentions: @ menu also lists subagents",
    allMentions.includes("explore") || allMentions.includes("general"),
    allMentions.replaceAll("\n", " | ").slice(0, 90),
  )
  await page.keyboard.press("Escape")
  await composer.fill("")

  // Compatibility roots: skills installed by `npx skills add` (`.agents`) and Claude Code
  // (`.claude`) must show up in `@` with the right origin, without extra configuration.
  await composer.fill("@e2e-agents")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const agentsMention = await page.locator(".suggestions").innerText()
  check(
    "mentions: ~/.agents/skills (npx skills add -g) appears as global",
    agentsMention.includes("e2e-agents-skill") && agentsMention.includes("Global"),
    agentsMention.replaceAll("\n", " | ").slice(0, 90),
  )
  await page.keyboard.press("Escape")
  await composer.fill("")
  await composer.fill("@e2e-claude")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const claudeMention = await page.locator(".suggestions").innerText()
  check(
    "mentions: ~/.claude/skills appears as global",
    claudeMention.includes("e2e-claude-skill"),
    claudeMention.replaceAll("\n", " | ").slice(0, 90),
  )
  await page.keyboard.press("Escape")
  await composer.fill("")
  await composer.fill("@e2e-project-agents")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const projectAgentsMention = await page.locator(".suggestions").innerText()
  check(
    "mentions: project .agents/skills appears as project",
    projectAgentsMention.includes("e2e-project-agents") && projectAgentsMention.includes("Proyecto"),
    projectAgentsMention.replaceAll("\n", " | ").slice(0, 90),
  )
  await page.keyboard.press("Escape")
  await composer.fill("")

  // Mid-session install: a SKILL.md dropped on disk (what the agent does with
  // `npx skills add -g`) must appear in `@` without restarting the app.
  seedSkill(path.join(homeDir, ".agents", "skills"), "e2e-midsession", "Skill instalada a mitad de sesión")
  await composer.fill("@e2e-midsession")
  const midSessionMention = await page
    .waitForSelector(".suggestion:has-text('e2e-midsession')", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check("mentions: skill installed mid-session appears in @ without restart", midSessionMention)
  await page.keyboard.press("Escape")
  await composer.fill("")

  // ---------------------------------------------------------------- `+` menu (files first, then skills fly-out)
  await page.click(".composer-chip[title='Adjuntar imagen']")
  await page.waitForSelector(".popover.attach-menu", { timeout: 5_000 })
  const attachMenuText = await page.locator(".popover.attach-menu").innerText()
  check(
    "composer: + menu shows file upload first",
    attachMenuText.includes("Subir o agregar archivos") &&
      attachMenuText.indexOf("Subir o agregar archivos") < attachMenuText.indexOf("Skills"),
    attachMenuText.replaceAll("\n", " | ").slice(0, 90),
  )
  await page.hover(".popover.attach-menu .skills-parent")
  await page.waitForSelector(".popover-submenu", { timeout: 5_000 })
  await page.screenshot({ path: path.join(shotsDir, "10a-plus-menu.png") })
  const submenuText = await page.locator(".popover-submenu").innerText()
  check("composer: skills fly-out lists installed skills", submenuText.includes("e2e-skill"), submenuText.replaceAll("\n", " | ").slice(0, 90))
  check(
    "composer: skills fly-out offers manage and explore",
    submenuText.includes("Administrar Skills") && submenuText.includes("Explorar Skills"),
  )
  check(
    "composer: skills fly-out shows names only (no description)",
    !submenuText.includes("Skill de prueba") && !submenuText.includes("npx skills"),
    submenuText.replaceAll("\n", " | ").slice(0, 90),
  )
  const attachMenuHtml = await page.locator(".popover.attach-menu").innerHTML()
  check(
    "composer: + menu uses monochrome svg icons",
    !/📎|🧩|⚙|＋/u.test(attachMenuHtml) && (await page.locator(".popover.attach-menu svg").count()) >= 4,
    `${await page.locator(".popover.attach-menu svg").count()} svg`,
  )
  await page.click(".popover-submenu .popover-item:has-text('e2e-skill')")
  await page.waitForTimeout(300)
  const chipFromMenu = await page.locator(".composer-attachment:has-text('e2e-skill')").count()
  check("composer: picking a skill in the fly-out attaches it as a chip", chipFromMenu >= 1)
  await page.click(".composer-attachment:has-text('e2e-skill') button")
  await page.waitForTimeout(200)

  // ---------------------------------------------------------------- skills manager (auto-id + global install)
  await composer.fill("/skill")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".modal.skill-manager", { timeout: 10_000 })
  const managerText = await page.locator(".modal.skill-manager").innerText()
  check("skills: manager lists the project skill", managerText.includes("e2e-skill"), managerText.replaceAll("\n", " | ").slice(0, 90))
  await page.screenshot({ path: path.join(shotsDir, "10b-skills-manager.png") })
  await page.click(".skill-add button")
  await page.waitForTimeout(250)
  await page.click(".skill-add-menu button:has-text('Crear skill')")
  await page.waitForSelector(".skill-create", { timeout: 5_000 })
  await page.fill(".skill-create input[placeholder='Mi skill']", "E2E Global")
  const autoIdText = await page.locator(".skill-create .hint").innerText()
  check("skills: id is auto-generated from the name", autoIdText.includes("e2e-global"), autoIdText)
  await page.fill(".skill-create textarea[placeholder='Qué hace y cuándo usarla']", "Skill global creada por el e2e")
  await page.fill(".skill-create textarea[placeholder*='# Mi skill']", "# E2E Global\n\nSaluda diciendo HOLA-GLOBAL.")
  await page.screenshot({ path: path.join(shotsDir, "10b-skill-create.png") })
  await page.click(".skill-create-actions button:has-text('Crear skill')")
  await page.waitForTimeout(900)
  const globalSkillFile = path.join(dataDir, "config", "skills", "e2e-global", "SKILL.md")
  check("skills: created with the auto id in the global folder", existsSync(globalSkillFile))
  const installedRow = await page.locator(".modal .skill-row:has-text('e2e-global')").count()
  check("skills: manager lists the new skill", installedRow >= 1, `${installedRow} rows`)
  await page.screenshot({ path: path.join(shotsDir, "10c-skills-created.png") })

  // Detail view: click a row → tabs (Descripción / Contenido) + edit and save to disk.
  await page.click(".modal .skill-row:has-text('e2e-agents-skill')")
  await page.waitForSelector(".skill-detail", { timeout: 5_000 })
  const detailMeta = await page.locator(".skill-detail-meta").innerText()
  check(
    "skills: detail shows origin and directory",
    detailMeta.includes("Global") && detailMeta.includes("e2e-agents-skill"),
    detailMeta.replaceAll("\n", " ").slice(0, 90),
  )
  await page.click(".skill-tabs button:has-text('Contenido')")
  await page.waitForTimeout(200)
  const detailContent = await page.locator(".skill-detail-pre").innerText()
  check(
    "skills: content tab shows the SKILL.md body",
    detailContent.includes("HOLA-E2E-AGENTS-SKILL"),
    detailContent.slice(0, 60).replaceAll("\n", " "),
  )
  await page.click(".skill-detail button:has-text('Editar')")
  await page.waitForSelector(".skill-detail .skill-editor-full", { timeout: 5_000 })
  await page.fill(".skill-detail .skill-editor-full", "# Editado por el e2e\n\nContenido nuevo del detalle.")
  await page.click(".skill-detail button:has-text('Guardar')")
  await page.waitForTimeout(900)
  const editedSkillFile = readFileSync(path.join(homeDir, ".agents", "skills", "e2e-agents-skill", "SKILL.md"), "utf8")
  check(
    "skills: edits are saved to disk (frontmatter preserved)",
    editedSkillFile.includes("Contenido nuevo del detalle") &&
      editedSkillFile.includes("license: MIT") &&
      editedSkillFile.includes("name: e2e-agents-skill"),
    editedSkillFile.split("\n").slice(0, 5).join(" | "),
  )
  const managerHtml = await page.locator(".modal.skill-manager").innerHTML()
  check("skills: manager uses monochrome svg icons", !/📄|🗑|📂/u.test(managerHtml))
  await page.screenshot({ path: path.join(shotsDir, "10d-skill-detail.png") })
  await page.click(".skill-detail button[title='Volver a Skills']")
  await page.waitForSelector(".skill-manager-list", { timeout: 5_000 })

  await page.click(".modal-close")
  await page.waitForTimeout(300)
  await composer.fill("@e2e-global")
  await page.waitForSelector(".suggestion", { timeout: 15_000 })
  const globalMention = await page.locator(".suggestions").innerText()
  check("skills: installed global skill appears in @ instantly", globalMention.includes("e2e-global"), globalMention.replaceAll("\n", " | ").slice(0, 90))
  await page.keyboard.press("Escape")
  await composer.fill("")

  // ---------------------------------------------------------------- skills manager (delete global skill)
  await page.click(".composer-chip[title='Adjuntar imagen']")
  await page.waitForTimeout(250)
  await page.hover(".popover.attach-menu .skills-parent")
  await page.waitForSelector(".popover-submenu", { timeout: 5_000 })
  await page.click(".popover-submenu .popover-item:has-text('Administrar Skills')")
  await page.waitForSelector(".modal.skill-manager", { timeout: 5_000 })
  await page.click(".modal .skill-row:has-text('e2e-global') button")
  await page.waitForSelector(".confirm-modal", { timeout: 5_000 })
  await page.click(".confirm-actions button:has-text('Eliminar')")
  await page.waitForTimeout(700)
  check("skills: manager can delete a global skill", !existsSync(globalSkillFile))
  await page.click(".modal-close")
  await page.waitForTimeout(250)

  // ---------------------------------------------------------------- thinking variants
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "gpt-5.4")
  await page.waitForTimeout(400)
  await page.click(".popover-item:has-text('gpt-5.4')")
  await page.waitForTimeout(600)
  const variantSelect = page.locator("select.composer-chip")
  check("variants: selector appears for reasoning models", (await variantSelect.count()) === 1)
  await variantSelect.selectOption("high")
  await page.waitForTimeout(500)
  const variantValue = await page.locator("select.composer-chip").inputValue()
  check("variants: active variant shown in the composer", variantValue === "high", variantValue)
  await composer.fill("Probando la variante de razonamiento")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(3000)
  const lastRequest = (await (await fetch(`http://127.0.0.1:${port}/last-request`)).json()) as {
    body?: { reasoning_effort?: string; model?: string }
  }
  check(
    "variants: reasoning_effort reaches the provider",
    lastRequest?.body?.reasoning_effort === "high",
    `model=${lastRequest?.body?.model} reasoning_effort=${lastRequest?.body?.reasoning_effort}`,
  )
  await page.screenshot({ path: path.join(shotsDir, "08-variant.png") })

  // ---------------------------------------------------------------- live models.dev catalog
  // The mock serves a models.dev fixture: a model the API offers (beam-free) with real
  // reasoning levels. It must appear in the picker with its variants and reach the provider.
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "beam")
  await page.waitForTimeout(400)
  const beamRow = await page.locator(".popover-item:has-text('beam-free')").count()
  check("models: live catalog adds new API models", beamRow >= 1, `${beamRow} rows`)
  await page.click(".popover-item:has-text('beam-free')")
  await page.waitForTimeout(700)
  const beamVariants = await page.locator("select.composer-chip option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  )
  check(
    "models: live catalog brings real thinking levels",
    beamVariants.join(",") === "default,low,medium,high,xhigh,max",
    beamVariants.join(","),
  )
  await page.locator("select.composer-chip").selectOption("high")
  await page.waitForTimeout(400)
  await composer.fill("Variante de razonamiento con el modelo beam")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(3500)
  const beamRequest = (await (await fetch(`http://127.0.0.1:${port}/last-request?model=beam-free`)).json()) as {
    body?: { model?: string; reasoning_effort?: string }
  }
  check(
    "models: beam-free effort reaches the provider",
    beamRequest?.body?.model === "beam-free" && beamRequest?.body?.reasoning_effort === "high",
    `model=${beamRequest?.body?.model} effort=${beamRequest?.body?.reasoning_effort}`,
  )
  // Restore the previous model for the following checks.
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "gpt-5.4")
  await page.waitForTimeout(400)
  await page.click(".popover-item:has-text('gpt-5.4')")
  await page.waitForTimeout(600)
  await page.locator("select.composer-chip").selectOption("high").catch(() => undefined)
  await page.waitForTimeout(300)

  // ---------------------------------------------------------------- Console account filter + grouped picker
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "glm")
  await page.waitForTimeout(400)
  check("account: models disabled on the platform are hidden", (await page.locator(".popover-item:not(.placeholder)").count()) === 0)
  await page.fill(".popover input", "hy3")
  await page.waitForTimeout(400)
  check("account: models outside the account list are hidden", (await page.locator(".popover-item:not(.placeholder)").count()) === 0)
  await page.fill(".popover input", "gpt-5.4")
  await page.waitForTimeout(400)
  check("account: active models remain available", (await page.locator(".popover-item:not(.placeholder)").count()) >= 1)
  await page.fill(".popover input", "beam")
  await page.waitForTimeout(400)
  const freeLabels = await page.locator(".popover-item .price").allInnerTexts()
  check("picker: free models are tagged", freeLabels.some((label) => label.includes("Gratis")), freeLabels.join(" | "))
  await page.fill(".popover input", "")
  await page.waitForTimeout(500)
  const providerLabels = await page.locator(".popover .provider-label").allInnerTexts()
  check(
    "picker: models are grouped by provider with separators",
    providerLabels.length >= 1 && providerLabels.some((label) => label.toLowerCase().includes("opencode")),
    providerLabels.join(" | "),
  )
  check(
    "picker: unconnected providers have no section",
    !providerLabels.some((label) => /google|anthropic/i.test(label)),
    providerLabels.join(" | "),
  )
  await page.keyboard.press("Escape")
  await page.waitForTimeout(250)
  if ((await page.locator(".popover").count()) > 0) await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(250)

  // ---------------------------------------------------------------- subagent inheritance (model + minimal variant)
  // Make another model the most recent one from a different session; subagents must
  // still inherit the parent's model (regression: they used to pick the recent default)
  // and run with the minimal thinking level.
  {
    const db = new Database(dbFile, { readonly: true })
    const other = db.query("SELECT id FROM session WHERE parent_id IS NOT NULL LIMIT 1").get() as { id: string } | null
    db.close()
    if (other) {
      await page.evaluate(
        async ({ sessionID }) => {
          await window.openorch.invoke("sessions.setModel", sessionID, { providerID: "mock", modelID: "mock-model" })
        },
        { sessionID: other.id },
      )
      await page.waitForTimeout(300)
    }
  }
  await composer.fill("Delegar en un subagente la exploración del proyecto")
  await page.keyboard.press("Enter")
  // The header shows the inherited model next to the description.
  await page.waitForSelector("text=Explorar con herencia", { timeout: 30_000 })
  await page.waitForTimeout(3000)
  const inheritedCard = await page.locator(".tool-card:has-text('Explorar con herencia')").first().innerText()
  check("subagents: card shows the inherited model", inheritedCard.includes("gpt-5.4"), inheritedCard.replaceAll("\n", " | ").slice(0, 110))
  check("subagents: card shows the minimal thinking level", inheritedCard.includes("#none"), inheritedCard.replaceAll("\n", " | ").slice(0, 110))
  {
    const db = new Database(dbFile, { readonly: true })
    const child = db
      .query("SELECT model FROM session WHERE parent_id IS NOT NULL ORDER BY time_created DESC LIMIT 1")
      .get() as { model?: string } | null
    db.close()
    check(
      "subagents: inherit the parent's model with a minimal variant",
      (child?.model ?? "").includes("gpt-5.4") && (child?.model ?? "").includes("none"),
      child?.model ?? "none",
    )
  }

  // Continuing a child must re-inherit the parent's current model.
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "mock-model")
  await page.waitForTimeout(400)
  await page.locator(".popover-item:has-text('mock-model')").first().click()
  await page.waitForTimeout(600)
  await composer.fill("Ahora continúa el subagente con el nuevo modelo")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(5000)
  {
    const db = new Database(dbFile, { readonly: true })
    const children = db
      .query("SELECT model, time_updated FROM session WHERE parent_id IS NOT NULL ORDER BY time_updated DESC")
      .all() as { model?: string; time_updated: number }[]
    db.close()
    check(
      "subagents: continuing re-inherits the parent's new model",
      (children[0]?.model ?? "").includes("mock-model"),
      children[0]?.model ?? "none",
    )
  }
  // The parent just switched models: its previous reasoning must not be replayed
  // as plain assistant text (that made weak models read old thinking as answers).
  {
    const request = (await (await fetch(`http://127.0.0.1:${port}/last-request`)).json()) as {
      body?: { messages?: { role?: string; content?: unknown; reasoning_content?: string }[] }
    }
    const assistantMessages = (request.body?.messages ?? []).filter((message) => message.role === "assistant")
    const leaked = assistantMessages.some((message) => typeof message.content === "string" && message.content.includes("Voy a pensar paso a paso"))
    const replayed = assistantMessages.some((message) => (message.reasoning_content ?? "").includes("Voy a pensar paso a paso"))
    check("model switch: old reasoning is never replayed as plain text", !leaked, `reasoning_content=${replayed}`)
  }
  // Restore the parent's model for the following checks.
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "gpt-5.4")
  await page.waitForTimeout(400)
  await page.click(".popover-item:has-text('gpt-5.4')")
  await page.waitForTimeout(400)
  await page.locator("select.composer-chip").selectOption("high").catch(() => undefined)
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- shell with a grandchild must not hang
  await composer.fill("Lanza un servidor persistente con un nieto")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".tool-card:has-text('Shell')", { timeout: 45_000 })
  check(
    "sidebar: a running session is tinted green",
    (await page.locator(".session-item.running, .workspace-entry.running").count()) > 0,
  )
  await page.waitForTimeout(8_000)
  const shellCard = page.locator(".tool-card:has-text('Shell')").last()
  await shellCard.locator(".tool-head").click()
  await page.waitForTimeout(600)
  const shellText = await shellCard.innerText()
  check(
    "shell: long-running command times out instead of hanging",
    shellText.includes("exceeded timeout"),
    shellText.replaceAll("\n", " | ").slice(0, 120),
  )
  await page.screenshot({ path: path.join(shotsDir, "13-shell-timeout.png") })

  // ---------------------------------------------------------------- external directory permission
  await composer.fill("Lee el archivo externo fuera de la carpeta")
  await page.keyboard.press("Enter")
  await page.waitForSelector(".dock.permission", { timeout: 30_000 })
  const permissionText = await page.locator(".dock.permission").innerText()
  check(
    "permissions: reading outside the folder asks first",
    permissionText.includes("external_directory"),
    permissionText.replaceAll("\n", " | ").slice(0, 110),
  )
  check(
    "sidebar: a pending permission tints the workspace yellow",
    (await page.locator(".workspace-entry.attention, .session-item.attention").count()) > 0,
  )
  await page.screenshot({ path: path.join(shotsDir, "14-external-permission.png") })
  await page.click(".dock.permission button:has-text('Permitir siempre')")
  await page.waitForTimeout(2500)
  const dockGone = (await page.locator(".dock.permission").count()) === 0
  check("permissions: the dock closes after allowing", dockGone)
  {
    const db = new Database(path.join(dataDir, "openorch.db"), { readonly: true })
    const found = db.query("SELECT COUNT(*) AS c FROM message WHERE data LIKE '%archivo fuera del workspace%'").get() as { c: number }
    const rules = db.query("SELECT action, resource FROM permission").all() as { action: string; resource: string }[]
    db.close()
    check("permissions: after allowing, the external read completes", found.c >= 1, `${found.c} results`)
    check(
      "permissions: 'always' persisted the external directory",
      rules.some((rule) => rule.action === "external_directory" && rule.resource.toLowerCase().includes("e2e")),
      `${rules.length} saved rules`,
    )
  }

  // ---------------------------------------------------------------- right dock: tabs, guide, terminal
  const terminalShells = (await page.evaluate(() => window.openorch.invoke("terminal.shells"))) as { id: string; name: string }[]
  check(
    "terminal: shells detected on this machine",
    Array.isArray(terminalShells) && terminalShells.length >= 1,
    terminalShells.map((entry) => entry.name).join(", ").slice(0, 90),
  )
  await page.click(".terminal-toggle")
  await page.waitForTimeout(1600)
  check("terminal: opening auto-creates one terminal tab", (await page.locator(".dock-tab").count()) === 1)
  // The single pane fills the whole dock width (no dead strip to its right).
  {
    const paneBox = await page.locator(".dock-pane").first().boundingBox()
    const panelBox = await page.locator(".terminal-panel").boundingBox()
    check(
      "dock: the pane fills the panel width",
      Boolean(paneBox && panelBox && Math.abs(paneBox.width - panelBox.width) <= 2),
      `pane=${paneBox?.width} panel=${panelBox?.width}`,
    )
  }
  // Guide (+): exactly two cards (Browser + New terminal) with the shell menu.
  await page.click(".dock-add")
  await page.waitForSelector(".guide", { timeout: 5_000 })
  const guideText = await page.locator(".guide").innerText()
  check("dock: guide shows exactly Browser + New terminal", (await page.locator(".guide-card").count()) === 2, `${await page.locator(".guide-card").count()} cards`)
  check(
    "dock: guide has no workspace-files card",
    guideText.includes("Navegador") && guideText.includes("Nueva terminal") && !guideText.includes("Workspace files"),
    guideText.replaceAll("\n", " | ").slice(0, 90),
  )
  await page
    .waitForFunction(() => document.querySelectorAll(".guide-shell-select option").length >= 1, undefined, { timeout: 10_000 })
    .catch(() => undefined)
  const shellOptions = await page.locator(".guide-shell-select option").count()
  check("dock: shell menu lists the detected shells", shellOptions >= 1, `${shellOptions} options`)
  // The guide tab closes like any other tab (opened by mistake) and reopens with +.
  await page.click(".dock-tab:has-text('Inicio') .dock-tab-close")
  await page.waitForTimeout(300)
  check("dock: the guide tab can be closed", (await page.locator(".dock-tab").filter({ hasText: "Inicio" }).count()) === 0)
  await page.click(".dock-add")
  await page.waitForSelector(".guide", { timeout: 5_000 })
  await page.click(".guide-card-main")
  await page.waitForTimeout(1400)
  check("dock: the guide card opens a second terminal", (await page.locator(".dock-tab").count()) === 2)
  check(
    "dock: tabs show a per-kind icon",
    (await page.locator(".dock-tab-icon").count()) === (await page.locator(".dock-tab").count()),
  )
  const ptysOpen = (await page.evaluate(() => window.openorch.invoke("terminal.list"))) as string[]
  check("terminal: both ptys are alive", ptysOpen.length === 2, `${ptysOpen.length} ptys`)
  // The panel is docked at the right side of the window.
  {
    const mainBox = await page.locator(".main").boundingBox()
    const panelBox = await page.locator(".terminal-panel").boundingBox()
    check(
      "terminal: panel docks on the right side",
      Boolean(mainBox && panelBox && panelBox.x > mainBox.x + 100 && panelBox.x + panelBox.width >= mainBox.x + mainBox.width - 2),
      `main=${mainBox?.x} panel=${panelBox?.x} width=${panelBox?.width}`,
    )
  }
  // Resize by dragging the left edge; the width is remembered.
  {
    const dragBy = async (delta: number) => {
      const handle = (await page.locator(".terminal-resize").boundingBox())!
      await page.mouse.move(handle.x + 3, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + 3 + delta, handle.y + handle.height / 2, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(350)
      return (await page.locator(".terminal-panel").boundingBox())!.width
    }
    const before = (await page.locator(".terminal-panel").boundingBox())!.width
    const smaller = await dragBy(120) // dragging right shrinks the right-docked panel
    const restored = await dragBy(-120)
    check(
      "terminal: dragging the edge resizes the panel",
      smaller < before - 60 && restored > smaller + 60,
      `${before} → ${smaller} → ${restored}`,
    )
    const storedWidth = await page.evaluate(() => localStorage.getItem("openorch.terminal.width"))
    check("terminal: resized width is remembered", Math.abs(Number(storedWidth) - restored) <= 15, `${storedWidth} vs ${restored}`)
  }
  // Dragging can never take the whole window (DSH caps the panel at 80%).
  {
    const handle = (await page.locator(".terminal-resize").boundingBox())!
    await page.mouse.move(handle.x + 3, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 3 - 1500, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(350)
    const appWidth = (await page.locator(".app").boundingBox())!.width
    const cappedWidth = (await page.locator(".terminal-panel").boundingBox())!.width
    const storedWidth = await page.evaluate(() => Number(localStorage.getItem("openorch.terminal.width")))
    check(
      "terminal: the panel width is capped at 80% of the window",
      storedWidth <= appWidth * 0.8 + 4 && storedWidth >= appWidth * 0.8 - 40 && cappedWidth >= 320,
      `stored=${storedWidth} rendered=${Math.round(cappedWidth)} app=${Math.round(appWidth)}`,
    )
    // Back to a comfortable width for the remaining checks.
    const handle2 = (await page.locator(".terminal-resize").boundingBox())!
    await page.mouse.move(handle2.x + 3, handle2.y + handle2.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle2.x + 3 + (cappedWidth - 430), handle2.y + handle2.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(350)
  }
  // Layout priorities: the conversation keeps its 380px minimum; the left sidebar
  // pushes the dock (shrinking it) instead of crushing the chat.
  {
    const handle = (await page.locator(".terminal-resize").boundingBox())!
    await page.mouse.move(handle.x + 3, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 3 - 1500, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(350)
    const chatWithSidebar = (await page.locator(".main").boundingBox())!
    const dockWithSidebar = (await page.locator(".terminal-panel").boundingBox())!.width
    check(
      "layout: the conversation keeps its minimum with a wide dock",
      chatWithSidebar.width >= 378,
      `chat=${Math.round(chatWithSidebar.width)} dock=${Math.round(dockWithSidebar)}`,
    )
    await page.click(".sidebar-header .brand .icon-button")
    await page.waitForTimeout(400)
    const chatNoSidebar = (await page.locator(".main").boundingBox())!.width
    const dockNoSidebar = (await page.locator(".terminal-panel").boundingBox())!.width
    check(
      "layout: closing the sidebar gives the space back to the dock",
      dockNoSidebar > dockWithSidebar + 100 && chatNoSidebar >= 378,
      `chat=${Math.round(chatNoSidebar)} dock=${Math.round(dockNoSidebar)}`,
    )
    await page.click("button[title='Mostrar barra lateral']")
    await page.waitForTimeout(400)
    const chatBack = (await page.locator(".main").boundingBox())!.width
    const dockBack = (await page.locator(".terminal-panel").boundingBox())!.width
    check(
      "layout: reopening the sidebar shrinks the dock, not the conversation",
      Math.abs(chatBack - chatWithSidebar.width) <= 4 && dockBack < dockNoSidebar - 100,
      `chat=${Math.round(chatBack)} dock=${Math.round(dockBack)}`,
    )
    const handle3 = (await page.locator(".terminal-resize").boundingBox())!
    await page.mouse.move(handle3.x + 3, handle3.y + handle3.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle3.x + 3 + (dockBack - 430), handle3.y + handle3.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(350)
  }

  // Hide with ✕ must NOT kill processes; reopening keeps the same tabs.
  await page.click(".terminal-panel button[title='Ocultar panel']")
  await page.waitForTimeout(500)
  check("terminal: ✕ hides the panel", (await page.locator(".terminal-panel.hidden").count()) === 1)
  const ptysAfterHide = (await page.evaluate(() => window.openorch.invoke("terminal.list"))) as string[]
  check("terminal: hiding does not kill the terminals", ptysAfterHide.length === 2, `${ptysAfterHide.length} ptys`)
  await page.click(".terminal-toggle")
  await page.waitForTimeout(800)
  check("terminal: reopening keeps the tabs", (await page.locator(".dock-tab").count()) === 2)

  // Maximize = fullscreen overlay (covers the app, conversation stays mounted).
  {
    const normal = (await page.locator(".terminal-panel").boundingBox())!.width
    const appBox = (await page.locator(".app").boundingBox())!
    await page.evaluate(() => {
      ;(document.querySelector(".timeline-inner") as HTMLElement | null)?.setAttribute("data-keep", "1")
    })
    await page.click(".terminal-panel button[title='Maximizar']")
    await page.waitForTimeout(350)
    const wideBox = (await page.locator(".terminal-panel").boundingBox())!
    check(
      "terminal: maximize covers the whole window",
      Math.abs(wideBox.width - appBox.width) <= 2 && Math.abs(wideBox.x - appBox.x) <= 2 && wideBox.height >= appBox.height - 2,
      `${Math.round(wideBox.width)}x${Math.round(wideBox.height)} vs app ${Math.round(appBox.width)}x${Math.round(appBox.height)}`,
    )
    check("terminal: the resize handle is hidden in fullscreen", (await page.locator(".terminal-resize").count()) === 0)
    await page.click(".terminal-panel button[title='Restaurar']")
    await page.waitForTimeout(350)
    const restored = (await page.locator(".terminal-panel").boundingBox())!.width
    check("terminal: restore returns to the normal size", Math.abs(restored - normal) < 20, `${restored} vs ${normal}`)
    const kept = await page.evaluate(() => document.querySelector(".timeline-inner")?.getAttribute("data-keep") === "1")
    check("terminal: fullscreen never remounts the conversation", kept)
    // Reopening the panel always starts in normal mode (never stays fullscreen).
    await page.click(".terminal-panel button[title='Maximizar']")
    await page.waitForTimeout(250)
    await page.click(".terminal-panel button[title='Ocultar panel']")
    await page.waitForTimeout(300)
    await page.click(".terminal-toggle")
    await page.waitForTimeout(600)
    const reopened = (await page.locator(".terminal-panel").boundingBox())!.width
    check("terminal: reopening starts in normal mode", Math.abs(reopened - normal) < 20, `${reopened} vs ${normal}`)
  }
  await page.screenshot({ path: path.join(shotsDir, "15-terminal.png") })

  // Copy: selection-aware chords must copy without sending SIGINT.
  const clipboardRoundTrip = await page.evaluate(async () => {
    await window.openorch.clipboard.writeText("ORCH-CLIP-TEST")
    return await window.openorch.clipboard.readText()
  })
  check("terminal: clipboard bridge round-trips", clipboardRoundTrip === "ORCH-CLIP-TEST", String(clipboardRoundTrip))
  const writeAndSelect = (text: string) =>
    page.evaluate(
      (value) =>
        new Promise<void>((resolve) => {
          const el = document.querySelector(".terminal-instance.active") as unknown as {
            __term?: { write: (data: string, callback?: () => void) => void; selectAll: () => void; focus: () => void }
          }
          const term = el?.__term
          if (!term) {
            resolve()
            return
          }
          term.write(value, () => {
            term.selectAll()
            term.focus()
            resolve()
          })
        }),
      text,
    )
  await writeAndSelect("\r\nORCH-COPY-1234\r\n")
  await page.keyboard.press("Control+Shift+C")
  await page.waitForTimeout(300)
  const copiedShift = await page.evaluate(() => window.openorch.clipboard.readText())
  check("terminal: Ctrl+Shift+C copies the selection", String(copiedShift).includes("ORCH-COPY-1234"), String(copiedShift).slice(0, 40))
  await writeAndSelect("\r\nORCH-COPY-5678\r\n")
  await page.keyboard.press("Control+C")
  await page.waitForTimeout(300)
  const copiedCtrl = await page.evaluate(() => window.openorch.clipboard.readText())
  check(
    "terminal: Ctrl+C with a selection copies instead of interrupting",
    String(copiedCtrl).includes("ORCH-COPY-5678"),
    String(copiedCtrl).slice(0, 40),
  )

  // Tab ✕ closes one terminal (and ends its pty).
  await page.locator(".dock-tab .dock-tab-close").first().click()
  await page.waitForTimeout(1000)
  check("terminal: the tab ✕ closes one terminal", (await page.locator(".dock-tab").count()) === 1)
  const ptysAfterClose = (await page.evaluate(() => window.openorch.invoke("terminal.list"))) as string[]
  check("terminal: closing a tab ends its pty", ptysAfterClose.length === 1, `${ptysAfterClose.length} ptys`)

  // ---------------------------------------------------------------- browser tab (webview preview)
  await page.click(".dock-add")
  await page.waitForSelector(".guide", { timeout: 5_000 })
  await page.click(".guide-card:has-text('Navegador')")
  await page.waitForSelector(".browser-toolbar", { timeout: 5_000 })
  check("browser: empty state asks for an address", (await page.locator(".browser-start").count()) === 1)
  const previewURL = `http://127.0.0.1:${port}/preview`
  const preview2URL = `http://127.0.0.1:${port}/preview2`
  await page.fill(".browser-address", previewURL)
  await page.keyboard.press("Enter")
  const loadedFirst = await page
    .waitForSelector(".dock-tab-title:has-text('Vista previa')", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check("browser: the webview loads the page (title observed)", loadedFirst)
  check("browser: the address bar follows the navigation", (await page.inputValue(".browser-address")) === previewURL)
  check("browser: open-in-system-browser button is available", await page.locator(".browser-external").isEnabled())
  await page.fill(".browser-address", preview2URL)
  await page.keyboard.press("Enter")
  const loadedSecond = await page
    .waitForSelector(".dock-tab-title:has-text('Segunda')", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check("browser: a second navigation updates the tab title", loadedSecond)
  await page.click(".browser-toolbar button[title='Atrás']")
  const wentBack = await page
    .waitForFunction(
      (target) => (document.querySelector(".browser-address") as HTMLInputElement | null)?.value === target,
      previewURL,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false)
  check("browser: Back returns to the previous page", wentBack)
  await page.click(".browser-toolbar button[title='Recargar']")
  await page.waitForTimeout(400)
  check("browser: reload keeps the page", (await page.inputValue(".browser-address")) === previewURL)
  await page.fill(".browser-address", "javascript:alert(1)")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(300)
  check(
    "browser: non-http(s) addresses are rejected",
    (await page.locator(".browser-error").count()) >= 1 && (await page.inputValue(".browser-address")) === previewURL,
  )
  await page.screenshot({ path: path.join(shotsDir, "16-browser.png") })

  // Shortcuts pressed inside the preview are routed to the app (DSH guest lease).
  {
    const box = (await page.locator(".browser-viewport").boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(300)
    await page.keyboard.press("Control+b")
    await page.waitForTimeout(400)
    const hiddenFromGuest = (await page.locator(".terminal-panel.hidden").count()) === 1
    await page.keyboard.press("Control+b")
    await page.waitForTimeout(400)
    check(
      "dock: shortcuts work while a preview has focus",
      hiddenFromGuest && (await page.locator(".terminal-panel.hidden").count()) === 0,
    )
  }

  // ---------------------------------------------------------------- split + drag & drop between panes
  await page.click(".dock-split")
  await page.waitForTimeout(500)
  check("dock: the split control opens a second pane", (await page.locator(".dock-pane").count()) === 2)
  check("dock: split is disabled at the two-pane limit", await page.locator(".dock-split").first().isDisabled())
  {
    const before = await page.locator(".dock-pane").first().boundingBox()
    const divider = (await page.locator(".dock-divider").boundingBox())!
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
    await page.mouse.down()
    await page.mouse.move(divider.x + divider.width / 2 - 140, divider.y + divider.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(350)
    const after = await page.locator(".dock-pane").first().boundingBox()
    const ratio = (await page.evaluate(() => JSON.parse(localStorage.getItem("openorch.dock.v1") ?? "{}").ratio)) as number
    check("dock: divider drag resizes the panes", Boolean(before && after && after.width < before.width - 40), `${before?.width} → ${after?.width}`)
    check("dock: split ratio stays within 20–80%", ratio >= 0.2 && ratio <= 0.8, `ratio=${ratio}`)
  }
  {
    const paneOneTabs = await page.locator(".dock-pane").first().locator(".dock-tab").count()
    const paneTwoTabs = await page.locator(".dock-pane").nth(1).locator(".dock-tab").count()
    await page
      .locator(".dock-pane")
      .first()
      .locator(".dock-tab")
      .first()
      .dragTo(page.locator(".dock-pane").nth(1).locator(".dock-pane-body"))
    await page.waitForTimeout(600)
    const movedOne = await page.locator(".dock-pane").first().locator(".dock-tab").count()
    const movedTwo = await page.locator(".dock-pane").nth(1).locator(".dock-tab").count()
    check(
      "dock: dragging a tab between panes moves it",
      movedOne === paneOneTabs - 1 && movedTwo === paneTwoTabs + 1,
      `${paneOneTabs}/${paneTwoTabs} → ${movedOne}/${movedTwo}`,
    )
  }
  await page.screenshot({ path: path.join(shotsDir, "17-split.png") })

  // ---------------------------------------------------------------- floating panel (one tab + re-dock)
  {
    await page.locator(".dock-tab").first().dragTo(page.locator(".timeline"))
    await page.waitForSelector(".dock-float", { timeout: 5_000 })
    check("dock: dropping a tab on the chat floats it", (await page.locator(".dock-float").count()) === 1)
    check("dock: the floating panel holds a single tab (no add control)", (await page.locator(".dock-float .dock-add").count()) === 0)
    check("dock: the floating panel offers re-dock", (await page.locator(".dock-float button[title='Reinsertar en el panel']").count()) === 1)
    const headerBox = (await page.locator(".dock-float-header").boundingBox())!
    const floatBefore = (await page.locator(".dock-float").boundingBox())!
    await page.mouse.move(headerBox.x + 40, headerBox.y + headerBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(headerBox.x + 40 - 90, headerBox.y + headerBox.height / 2 + 40, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const floatAfter = (await page.locator(".dock-float").boundingBox())!
    check("dock: the floating panel is movable", Math.abs(floatAfter.x - floatBefore.x) > 40, `${floatBefore.x} → ${floatAfter.x}`)
    await page.screenshot({ path: path.join(shotsDir, "18-float.png") })
    const tabsBeforeDock = await page.locator(".dock-tab").count()
    await page.click(".dock-float button[title='Reinsertar en el panel']")
    await page.waitForTimeout(500)
    check(
      "dock: re-dock returns the tab to the panel",
      (await page.locator(".dock-float").count()) === 0 && (await page.locator(".dock-tab").count()) === tabsBeforeDock + 1,
    )
  }

  // ---------------------------------------------------------------- dock shortcuts + persistence
  {
    // Guarantee embedder focus: key events inside a webview guest never reach the app.
    await page.locator(".composer textarea").click()
    await page.waitForTimeout(200)
    const beforeT = await page.locator(".dock-tab").count()
    await page.keyboard.press("Control+t")
    await page.waitForTimeout(500)
    check("dock: Ctrl+T opens a browser tab", (await page.locator(".dock-tab").count()) === beforeT + 1)
    const beforeBackquote = await page.locator(".dock-tab").count()
    const guidesBefore = await page.locator(".dock-tab").filter({ hasText: "Inicio" }).count()
    await page.keyboard.press("Control+Backquote")
    await page.waitForTimeout(900)
    const afterBackquote = await page.locator(".dock-tab").count()
    const guidesAfter = await page.locator(".dock-tab").filter({ hasText: "Inicio" }).count()
    check(
      "dock: Ctrl+` opens a terminal (replacing the guide)",
      afterBackquote === beforeBackquote + 1 - guidesBefore && guidesAfter === 0,
      `${beforeBackquote}/${guidesBefore} → ${afterBackquote}/${guidesAfter}`,
    )
    const beforeW = await page.locator(".dock-tab").count()
    await page.keyboard.press("Control+w")
    await page.waitForTimeout(500)
    check(
      "dock: Ctrl+W closes the active tab (window stays open)",
      (await page.locator(".dock-tab").count()) === beforeW - 1 && (await page.locator(".app").count()) === 1,
    )
    await page.keyboard.press("Control+b")
    await page.waitForTimeout(400)
    check("dock: Ctrl+B hides the panel", (await page.locator(".terminal-panel.hidden").count()) === 1)
    await page.keyboard.press("Control+b")
    await page.waitForTimeout(400)
    const storedDock = await page.evaluate(() => localStorage.getItem("openorch.dock.v1"))
    check("dock: layout is persisted per launch", Boolean(storedDock && storedDock.includes('"kind"')), (storedDock ?? "").slice(0, 60))
  }

  // ---------------------------------------------------------------- browser-like tab shrinking
  {
    await page.locator(".dock-pane").first().locator(".dock-tab").first().click()
    await page.waitForTimeout(200)
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("Control+t")
      await page.waitForTimeout(300)
    }
    const strip = await page
      .locator(".dock-pane")
      .first()
      .locator(".dock-tabs")
      .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    const widths = await page
      .locator(".dock-pane")
      .first()
      .locator(".dock-tab")
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)))
    const widest = widths.length > 0 ? Math.max(...widths) : 0
    const atFloor = widths.every((width) => width <= 62)
    check(
      "dock: tabs shrink to fit instead of overflowing",
      widths.length >= 4 && widest < 190 && (strip.scroll <= strip.client + 2 || atFloor),
      `scroll=${strip.scroll} client=${strip.client} widths=${widths.join(",")}`,
    )
    const closeBoxes = await page
      .locator(".dock-pane")
      .first()
      .locator(".dock-tab-close")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          w: Math.round(node.getBoundingClientRect().width),
          o: Number(getComputedStyle(node).opacity),
        })),
      )
    check(
      "dock: every shrunk tab keeps its ✕ fully visible",
      closeBoxes.length === widths.length && closeBoxes.every((box) => box.w >= 12 && box.o > 0.9),
      JSON.stringify(closeBoxes),
    )
    const beforeClose = await page.locator(".dock-pane").first().locator(".dock-tab").count()
    await page.locator(".dock-pane").first().locator(".dock-tab-close").first().click()
    await page.waitForTimeout(300)
    check(
      "dock: a shrunk tab closes with its ✕",
      (await page.locator(".dock-pane").first().locator(".dock-tab").count()) === beforeClose - 1,
    )
    await page.screenshot({ path: path.join(shotsDir, "19-tabs.png") })
  }

  // Close every remaining tab: the last terminal ends its pty.
  {
    for (let i = 0; i < 14; i += 1) {
      const close = page.locator(".dock-tab .dock-tab-close").first()
      if ((await close.count()) === 0) break
      await close.click()
      await page.waitForTimeout(450)
    }
    const ptysEnd = (await page.evaluate(() => window.openorch.invoke("terminal.list"))) as string[]
    check("terminal: closing the tabs ends their ptys", ptysEnd.length === 0, `${ptysEnd.length} ptys`)
    await page.click(".terminal-panel button[title='Ocultar panel']")
    await page.waitForTimeout(400)
  }

  // ---------------------------------------------------------------- the agent installs an MCP from the chat
  {
    await composer.fill("Instala este mcp para usarlo en el proyecto")
    await page.keyboard.press("Enter")
    const mcpCard = await page
      .waitForSelector(".tool-card:has-text('mcp')", { timeout: 30_000 })
      .then(() => true)
      .catch(() => false)
    check("mcp tool: the agent call is recorded as a tool card", mcpCard)
    let installed: { name: string; status: string; toolNames?: string[] } | undefined
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = (await page.evaluate(() => window.openorch.invoke("mcp.status"))) as {
        name: string
        status: string
        toolNames?: string[]
      }[]
      installed = status.find((entry) => entry.name === "agentmcp")
      if (installed?.status === "connected") break
      await page.waitForTimeout(500)
    }
    check(
      "mcp tool: the server is connected with its tools",
      installed?.status === "connected" && (installed?.toolNames ?? []).includes("echo"),
      JSON.stringify(installed ?? {}).slice(0, 90),
    )
    const savedConfig = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as {
      mcp?: Record<string, unknown>
    }
    check("mcp tool: the server is persisted in config.json", Boolean(savedConfig.mcp?.agentmcp), Object.keys(savedConfig.mcp ?? {}).join(", "))
    const buttonAfterInstall = await page.locator(".mcp-button").innerText()
    check("mcp tool: the sidebar turns green", buttonAfterInstall.includes("Conectado"), buttonAfterInstall.replaceAll("\n", " | ").slice(0, 60))
    await page.screenshot({ path: path.join(shotsDir, "20-mcp-tool.png") })
  }

  // ---------------------------------------------------------------- external config edits apply live (watcher)
  {
    const configPath = path.join(dataDir, "config.json")
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcp?: Record<string, unknown> }
    config.mcp = { ...(config.mcp ?? {}), watchedmcp: { type: "local", command: ["bun", "run", path.join(root, "scripts", "mock-mcp.ts")], enabled: true } }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    await page.waitForTimeout(2500)
    const watchedStatus = (await page.evaluate(() => window.openorch.invoke("mcp.status"))) as { name: string; status: string }[]
    check(
      "mcp: external config edits apply live (watcher)",
      watchedStatus.some((entry) => entry.name === "watchedmcp" && entry.status === "connected"),
      watchedStatus.map((entry) => `${entry.name}:${entry.status}`).join(", ").slice(0, 90),
    )
  }

  // ---------------------------------------------------------------- `!` shell commands in the composer
  await composer.fill("!echo ORCH-BANG-OK")
  await page.waitForTimeout(300)
  check("bang: hint appears while typing a ! command", (await page.locator(".composer-shell-hint").count()) >= 1)
  await page.keyboard.press("Enter")
  const bangOk = await page
    .waitForSelector("text=ORCH-BANG-OK", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check("bang: command output lands in the timeline", bangOk)

  // ---------------------------------------------------------------- model memory
  await page.click("text=Nueva sesión")
  await page.waitForTimeout(800)
  const headerModel = await page.locator(".composer-chip[title='Modelo']").innerText()
  check("models: new session remembers the last used model", headerModel.includes("gpt-5.4"), headerModel)
  const rememberedVariant = await page.locator("select.composer-chip").inputValue()
  check("variants: remembered variant restored for the model", rememberedVariant === "high", rememberedVariant)

  // ---------------------------------------------------------------- removed model fallback
  await page.evaluate(async () => {
    await window.openorch.invoke("config.set", { providers: { opencode: { enabled: false } } })
  })
  await page.waitForTimeout(600)
  await composer.fill("Hola tras retirar el modelo")
  await page.keyboard.press("Enter")
  const fallbackNotice = await page
    .waitForSelector("text=ya no está disponible", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check("models: removed model falls back with a notice", fallbackNotice)
  await page.screenshot({ path: path.join(shotsDir, "09-model-fallback.png") })
  await page.evaluate(async () => {
    await window.openorch.invoke("config.set", { providers: { opencode: { enabled: true } } })
  })
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- variants require catalog options
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "mimo")
  await page.waitForTimeout(500)
  await page.click(".popover-item:has-text('mimo-v2.6-flash')")
  await page.waitForTimeout(700)
  const variantSelects = await page.locator("select.composer-chip").count()
  check("variants: no selector for models without reasoning options", variantSelects === 0, `${variantSelects} selects`)

  // ---------------------------------------------------------------- connected providers + API model refresh
  await page.click("text=Ajustes")
  await page.waitForTimeout(500)
  await page.click(".modal-nav button:has-text('Proveedores')")
  await page.waitForTimeout(500)
  const connectedCount = await page.locator(".provider-row.connected").count()
  check("providers: connected section lists configured providers", connectedCount >= 2, `${connectedCount} connected`)
  await page.screenshot({ path: path.join(shotsDir, "11-connected.png") })

  await page.click(".provider-row.connected:has-text('Mock Provider') button:has-text('Refrescar modelos')")
  await page.waitForTimeout(1800)
  const refreshText = await page
    .locator(".refresh-info")
    .innerText()
    .catch(() => "")
  check("models: refresh from /models reports the API catalog", refreshText.includes("mock"), refreshText.slice(0, 80))
  await page.click(".modal-close")
  await page.waitForTimeout(400)
  await page.click(".composer-chip[title='Modelo']")
  await page.waitForTimeout(400)
  await page.fill(".popover input", "mock-model-mini")
  await page.waitForTimeout(600)
  const discoveredRow = await page.locator(".popover-item:has-text('mock-model-mini')").count()
  check("models: API-discovered model appears in the picker", discoveredRow >= 1, `${discoveredRow} rows`)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
  await page.locator(".composer textarea").click()

  await page.click("text=Ajustes")
  await page.waitForTimeout(600)
  await page.click(".modal-nav button:has-text('Proveedores')")
  await page.waitForTimeout(400)
  await page.click(".provider-row.connected:has-text('Mock Provider') button:has-text('Desconectar')")
  await page.waitForTimeout(500)
  const disconnectModal = await page.locator(".confirm-modal").isVisible()
  check("providers: disconnect asks for confirmation", disconnectModal)
  await page.click(".confirm-modal button:has-text('Desconectar')")
  await page.waitForTimeout(1000)
  const connectedAfter = await page.locator(".provider-row.connected").count()
  check("providers: disconnect removes the credential", connectedAfter === connectedCount - 1, `${connectedAfter} connected`)
  await page.screenshot({ path: path.join(shotsDir, "12-disconnected.png") })
  await page.click(".modal-close")
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- workspace tree: search + sort
  await page.click(".workspace-section-actions button[title='Buscar']")
  await page.waitForTimeout(300)
  await page.fill(".workspace-search", "zzz-no-match")
  await page.waitForTimeout(400)
  check("sidebar: search hides non-matching workspaces", (await page.locator(".workspace-entry").count()) === 0)
  await page.fill(".workspace-search", "other-work")
  await page.waitForTimeout(400)
  const searched = await page.locator(".workspace-entry").allInnerTexts()
  check("sidebar: search keeps matching workspaces", searched.length === 1 && searched[0]!.includes("other-workspace"), searched.join(" | "))
  await page.fill(".workspace-search", "")
  await page.waitForTimeout(200)
  await page.click(".workspace-section-actions button[title='Buscar']")
  await page.waitForTimeout(300)
  await page.click(".workspace-section-actions button[title='Orden: Recientes']")
  await page.waitForTimeout(300)
  check("sidebar: sort switches to name order", (await page.locator(".session-list[data-sort='name']").count()) === 1)
  await page.click(".workspace-section-actions button[title='Orden: Nombre']")
  await page.waitForTimeout(200)

  // ---------------------------------------------------------------- workspace trash (remove without deleting)
  {
    const otherEntry = page.locator(".workspace-entry", { hasText: "other-workspace" }).first()
    await otherEntry.hover()
    await otherEntry.locator("button[title='Quitar del espacio de trabajo']").click()
    await page.waitForTimeout(400)
    check("workspace: trash asks for confirmation", await page.locator(".confirm-modal").isVisible())
    await page.click(".confirm-modal button:has-text('Cancelar')")
    await page.waitForTimeout(300)
    check("workspace: cancel keeps it", (await page.locator(".workspace-entry", { hasText: "other-workspace" }).count()) === 1)

    await otherEntry.hover()
    await otherEntry.locator("button[title='Quitar del espacio de trabajo']").click()
    await page.waitForTimeout(300)
    await page.click(".confirm-modal button:has-text('Quitar')")
    await page.waitForTimeout(700)
    check("workspace: removing hides it from the list", (await page.locator(".workspace-entry", { hasText: "other-workspace" }).count()) === 0)
    const afterRemoval = (await page.evaluate(async () => {
      const config = (await window.openorch.invoke("config.get")) as { hiddenDirectories?: string[] }
      const sessions = (await window.openorch.invoke("sessions.list")) as { directory: string }[]
      return {
        hidden: config.hiddenDirectories ?? [],
        sessions: sessions.filter((session) => session.directory.endsWith("other-workspace")).length,
      }
    })) as { hidden: string[]; sessions: number }
    check(
      "workspace: nothing is deleted (sessions survive)",
      afterRemoval.hidden.some((directory) => directory.endsWith("other-workspace")) && afterRemoval.sessions >= 1,
      `hidden=${afterRemoval.hidden.length} sessions=${afterRemoval.sessions}`,
    )
    // Reopening it (same path the UI uses) brings it back with its sessions.
    await page.evaluate(async () => {
      await window.openorch.invoke("config.set", { hiddenDirectories: [] })
    })
    await page.waitForTimeout(600)
    check("workspace: reopening brings it back", (await page.locator(".workspace-entry", { hasText: "other-workspace" }).count()) === 1)
  }

  // Sidebar drag & drop: a dropped file (no real path) shows the friendly error.
  await page.evaluate(() => {
    const list = document.querySelector(".session-list")
    if (!list) return
    const transfer = new DataTransfer()
    transfer.items.add(new File(["x"], "nota.txt", { type: "text/plain" }))
    list.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }))
    list.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await page.waitForTimeout(400)
  const sidebarDropError = await page.locator(".workspace-drop-error").innerText().catch(() => "")
  check("sidebar: dropping a file shows a friendly error", sidebarDropError.toLowerCase().includes("carpeta"), sidebarDropError.slice(0, 60))

  // ---------------------------------------------------------------- agent browser tools (dock webview via CDP)
  await composer.fill("Haz la compra de prueba en el navegador del dock")
  await page.keyboard.press("Enter")
  // The first action on a new origin asks for permission (per-site, saved with "always").
  await page.waitForSelector(".dock.permission", { timeout: 45_000 })
  const browserPermission = await page.locator(".dock.permission").innerText()
  check(
    "browser tools: page actions ask for permission per site",
    browserPermission.includes("browser") && browserPermission.includes("127.0.0.1"),
    browserPermission.replaceAll("\n", " | ").slice(0, 110),
  )
  await page.click(".dock.permission button:has-text('Permitir siempre')")
  const shopLoaded = await page
    .waitForSelector(".dock-tab-title:has-text('Tienda E2E')", { timeout: 45_000 })
    .then(() => true)
    .catch(() => false)
  check("browser tools: the agent opens and navigates a dock tab", shopLoaded)
  {
    // Wait for the Code Mode call to finish (subtitle counts the nested calls), then
    // expand it: the result is only rendered while the card is open.
    const done = await page
      .waitForFunction(
        () => {
          const cards = [...document.querySelectorAll(".tool-card")].filter((node) => node.textContent?.includes("Code Mode"))
          return Boolean(cards.at(-1)?.textContent?.includes("tool calls"))
        },
        undefined,
        { timeout: 45_000 },
      )
      .then(() => true)
      .catch(() => false)
    const card = page.locator(".tool-card:has-text('Code Mode')").last()
    if ((await card.locator(".tool-body").count()) === 0) await card.locator(".tool-head").click().catch(() => undefined)
    await page.waitForTimeout(400)
    const executeText = await card.innerText().catch(() => "")
    check(
      "browser tools: fill + click add the product to the cart",
      done && executeText.includes("En el carrito: 2"),
      executeText.replaceAll("\n", " | ").slice(-180),
    )
    await page.screenshot({ path: path.join(shotsDir, "17-agent-browser.png") })
  }

  // ---------------------------------------------------------------- scheduled tasks
  await page.click(".schedule-button")
  const scheduleOpen = await page.waitForSelector(".schedule-modal", { timeout: 10_000 }).then(() => true).catch(() => false)
  check("scheduled: the sidebar button opens the task window", scheduleOpen)
  check("scheduled: the empty state offers a new task", (await page.locator(".schedule-new").count()) === 1)
  await page.click(".schedule-new")
  await page.waitForSelector(".schedule-form", { timeout: 10_000 })
  await page.locator(".schedule-form .schedule-field input").first().fill("Tarea E2E")
  await page.locator(".schedule-field textarea").first().fill("Devuelve el texto E2E-SCHEDULE-OK.")
  await page.click(".schedule-form-actions button.primary")
  await page.waitForSelector(".schedule-detail", { timeout: 20_000 })
  check("scheduled: creation saves immediately without a review step", (await page.locator(".schedule-review, .schedule-clarify").count()) === 0)
  const scheduled = (await page.evaluate(() => window.openorch.invoke("schedule.list"))) as { id: string; title: string; enabled: boolean }[]
  check(
    "scheduled: the task is persisted and listed in the sidebar",
    scheduled.length === 1 && scheduled[0].title === "Tarea E2E" && (await page.locator(".schedule-row").count()) === 1,
    scheduled[0]?.title,
  )

  await page.click(".schedule-row-title")
  await page.waitForSelector(".schedule-form", { timeout: 5_000 })
  const prefilled = await page.locator(".schedule-field textarea").first().inputValue()
  const saveLabel = (await page.locator(".schedule-form-actions button.primary").innerText()).trim()
  check(
    "scheduled: clicking a task opens the form prefilled with its data",
    (await page.locator(".schedule-detail").count()) === 0 && prefilled.includes("E2E-SCHEDULE-OK"),
    prefilled.slice(0, 60),
  )
  check("scheduled: the primary action becomes Save changes", saveLabel === "Guardar cambios", saveLabel)
  await page.locator(".schedule-form .schedule-field input").first().fill("Tarea E2E editada")
  await page.click(".schedule-form-actions button.primary")
  await page.waitForSelector(".schedule-detail", { timeout: 10_000 })
  const editedTasks = (await page.evaluate(() => window.openorch.invoke("schedule.list"))) as { title: string }[]
  check("scheduled: saving an edit updates the task", editedTasks[0]?.title === "Tarea E2E editada", editedTasks[0]?.title)

  await page.click(".schedule-row-menu-button")
  await page.waitForSelector(".schedule-task-menu", { timeout: 5_000 })
  check("scheduled: the task menu offers run, pause and delete", (await page.locator(".schedule-task-menu button").count()) === 3)
  await page.click(".schedule-task-menu button:has-text('Pausar')")
  await page.waitForTimeout(600)
  const paused = (await page.evaluate(() => window.openorch.invoke("schedule.list"))) as { enabled: boolean; background: boolean }[]
  const configAfterPause = (await page.evaluate(() => window.openorch.invoke("config.get"))) as {
    schedule: { startWithWindows: boolean }
  }
  check(
    "scheduled: pausing the last task turns off background mode",
    paused[0]?.enabled === false && paused[0]?.background === false && configAfterPause.schedule.startWithWindows === false,
    `enabled=${paused[0]?.enabled} background=${paused[0]?.background} startup=${configAfterPause.schedule.startWithWindows}`,
  )

  await page.click(".schedule-row-menu-button")
  await page.waitForSelector(".schedule-task-menu", { timeout: 5_000 })
  await page.click(".schedule-task-menu button:has-text('Ejecutar ahora')")
  let scheduledView: { runs: { status: string }[] } | null = null
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(500)
    scheduledView = (await page.evaluate(
      (id) => window.openorch.invoke("schedule.view", id),
      scheduled[0].id,
    )) as { runs: { status: string }[] } | null
    if (scheduledView?.runs[0] && scheduledView.runs[0].status !== "running") break
  }
  check("scheduled: Run now executes a paused task", scheduledView?.runs[0]?.status === "success", scheduledView?.runs[0]?.status)

  const sessionsBeforeScheduleDelete = (await page.evaluate(() => window.openorch.invoke("sessions.list"))) as unknown[]
  await page.click(".schedule-row-menu-button")
  await page.waitForSelector(".schedule-task-menu", { timeout: 5_000 })
  await page.click(".schedule-task-menu button:has-text('Eliminar')")
  await page.waitForSelector(".confirm-modal", { timeout: 5_000 })
  check("scheduled: deleting asks for confirmation", await page.locator(".confirm-modal").isVisible())
  await page.click(".confirm-modal button:has-text('Eliminar')")
  await page.waitForTimeout(800)
  const scheduledAfterDelete = (await page.evaluate(() => window.openorch.invoke("schedule.list"))) as unknown[]
  const sessionsAfterScheduleDelete = (await page.evaluate(() => window.openorch.invoke("sessions.list"))) as unknown[]
  check("scheduled: delete removes the task", scheduledAfterDelete.length === 0)
  check(
    "scheduled: delete keeps the sessions it already created",
    sessionsAfterScheduleDelete.length === sessionsBeforeScheduleDelete.length,
    `${sessionsAfterScheduleDelete.length}/${sessionsBeforeScheduleDelete.length}`,
  )
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)

  // ---------------------------------------------------------------- session switching
  const switchTargets = page.locator(".session-item")
  const switchCount = await switchTargets.count()
  for (let index = 0; index < Math.min(switchCount, 6); index += 1) {
    await switchTargets.nth(index).click()
    await page.waitForTimeout(250)
  }
  check(
    "sessions: switching through recent transcripts does not crash",
    pageErrors.length === 0 && (await page.locator(".message-error").count()) === 0,
    pageErrors.join(" | ").slice(0, 120),
  )

  // ---------------------------------------------------------------- delete confirmation
  const sessionCountBefore = await page.locator(".session-item").count()
  await page.hover(".session-item")
  await page.click(".session-item .icon-button[title='Eliminar']")
  await page.waitForTimeout(400)
  const modalVisible = await page.locator(".confirm-modal").isVisible()
  check("delete: confirmation dialog appears", modalVisible)
  await page.screenshot({ path: path.join(shotsDir, "06-confirm-delete.png") })
  await page.click(".confirm-modal button:has-text('Cancelar')")
  await page.waitForTimeout(400)
  const countAfterCancel = await page.locator(".session-item").count()
  check("delete: cancel keeps the session", countAfterCancel === sessionCountBefore, `${countAfterCancel}/${sessionCountBefore}`)

  // Confirm deletion for good.
  await page.hover(".session-item")
  await page.click(".session-item .icon-button[title='Eliminar']")
  await page.waitForTimeout(400)
  await page.click(".confirm-modal button:has-text('Eliminar')")
  await page.waitForTimeout(800)
  const countAfterConfirm = await page.locator(".session-item").count()
  check("delete: confirm removes the session", countAfterConfirm === sessionCountBefore - 1, `${countAfterConfirm} left`)

  // ---------------------------------------------------------------- settings screenshot
  await page.click("text=Ajustes")
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(shotsDir, "07-settings.png") })
  await page.keyboard.press("Escape")

  // Playwright's Electron close occasionally waits on the process exit on Windows;
  // the window (and all its handles) is already gone at that point.
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15_000))])
  app.process().kill()

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`shots in ${shotsDir}`)
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error("e2e failed:", error)
  await appHandle?.close().catch(() => undefined)
  mock?.kill()
  process.exit(1)
}
mock?.kill()
process.exit(results.some((entry) => !entry.ok) ? 1 : 0)
