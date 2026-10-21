import path from "node:path"
import { statSync } from "node:fs"
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron"
import { Engine, availableShells } from "@openorch/core"
import type { EngineEvent, PromptInput, ModelRef, PermissionReply, QuestionAnswer } from "@openorch/shared"
import { DockBrowser } from "./browser"
import { ExtensionBridge } from "./browser-bridge"
import { BrowserRouter, ExtensionBrowser } from "./extension-browser"
import { TRAY_ICON_DATA_URL } from "./tray-icon"

app.setName("OpenOrch")
app.setAppUserModelId("OpenOrch")

let engine: Engine
let mainWindow: BrowserWindow | undefined
let extensionBridge: ExtensionBridge | undefined
let tray: Tray | undefined
let quitting = false
let trayHintShown = false
let notificationIcon: ReturnType<typeof nativeImage.createFromDataURL> | undefined
let backgroundLaunch = process.argv.includes("--background")
/** The renderer only needs token/tool deltas for the session it is showing. */
let watchedSessionID: string | undefined
const liveNotifications = new Set<Notification>()
const dockBrowser = new DockBrowser(send)

/** Folder the user loads in edge://extensions (created by the app's setup copy). */
function extensionFolder(): string {
  return path.join(app.getPath("desktop"), "OpenOrch Browser Extension")
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

/** High-frequency events that are only useful for the session currently on screen. */
function isTranscriptEvent(event: EngineEvent): boolean {
  switch (event.type) {
    case "message.created":
    case "message.updated":
    case "message.deleted":
    case "part.created":
    case "part.delta":
    case "part.updated":
      return true
    default:
      return false
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayImage(): ReturnType<typeof nativeImage.createFromDataURL> {
  notificationIcon ??= nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  return notificationIcon
}

function hasBackgroundTasks(): boolean {
  try {
    return engine.schedule.list().some((task) => task.enabled && task.background)
  } catch {
    return false
  }
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(trayImage())
  tray.setToolTip("OpenOrch")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir OpenOrch", click: () => showWindow() },
      {
        label: "Tareas programadas",
        click: () => {
          showWindow()
          send("schedule:open", {})
        },
      },
      { type: "separator" },
      {
        label: "Salir",
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on("click", () => showWindow())
  tray.on("double-click", () => showWindow())
}

function destroyTray(): void {
  tray?.destroy()
  tray = undefined
}

function refreshTray(): void {
  if (hasBackgroundTasks() || backgroundLaunch) ensureTray()
  else if (mainWindow?.isVisible()) destroyTray()
}

let syncingBackgroundMode = false

/**
 * Keeps the "run in background" mode consistent with the tasks. When the last
 * enabled background task is paused/removed, clear the Windows login item and
 * the tray so the app can close normally again.
 */
async function syncBackgroundMode(): Promise<void> {
  if (syncingBackgroundMode) return
  if (hasBackgroundTasks()) {
    refreshTray()
    return
  }
  syncingBackgroundMode = true
  try {
    if (engine.getConfig().schedule.startWithWindows) {
      await engine.setConfig({ schedule: { startWithWindows: false } })
      applyLoginItem(false)
    }
    backgroundLaunch = false
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showWindow()
    destroyTray()
  } catch (error) {
    console.error("[main] could not disable background mode:", error)
  } finally {
    syncingBackgroundMode = false
  }
}

function showNotification(
  title: string,
  body: string,
  action?: { taskID?: string; sessionID?: string; directory?: string },
): void {
  if (process.env.OPENORCH_DISABLE_NOTIFICATIONS === "1") return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, icon: trayImage(), silent: false })
  liveNotifications.add(notification)
  notification.on("close", () => liveNotifications.delete(notification))
  notification.on("click", () => {
    showWindow()
    if (action?.sessionID && action.directory) {
      send("session:open", { sessionID: action.sessionID, directory: action.directory })
    } else if (action?.taskID) {
      send("schedule:open", { taskID: action.taskID })
    }
  })
  notification.show()
}

function handleEngineEvent(event: EngineEvent): void {
  if (event.type === "schedule.run") {
    const task = event.task
    if (task.notify) {
      const failed = event.run.status !== "success"
      const summary = failed
        ? event.run.error?.replaceAll(/\s+/g, " ").slice(0, 300) || "La tarea falló."
        : event.run.summary?.replaceAll(/\s+/g, " ").slice(0, 300) || "Tarea completada."
      showNotification(`OpenOrch · ${task.title}`, summary, {
        taskID: task.id,
        sessionID: event.run.sessionID,
        directory: task.workspace,
      })
    }
    void syncBackgroundMode()
    return
  }
  if (event.type === "schedule.updated" || event.type === "schedule.deleted") {
    void syncBackgroundMode()
    return
  }
  if (event.type === "permission.asked" || event.type === "question.asked") {
    const task = engine.schedule.taskForSession(event.request.sessionID)
    if (task) {
      showNotification(`OpenOrch · ${task.title}`, "La tarea necesita tu intervención para continuar.", {
        taskID: task.id,
        sessionID: event.request.sessionID,
        directory: task.workspace,
      })
    }
  }
}

function applyLoginItem(enabled: boolean): void {
  if (process.env.OPENORCH_DISABLE_LOGIN_ITEM === "1") return
  try {
    const args = app.isPackaged ? ["--background"] : ["--background", app.getAppPath()]
    app.setLoginItemSettings({ openAtLogin: enabled, args })
  } catch (error) {
    console.error("[main] could not update the login item:", error)
  }
}

function resolveProjectDirectory(): string {
  if (process.env.OPENORCH_DIR) return process.env.OPENORCH_DIR
  const config = engine.getConfig()
  if (config.lastDirectory) return config.lastDirectory
  return app.getPath("home")
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0c0f",
    autoHideMenuBar: true,
    show: false,
    title: "OpenOrch",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The dock's browser tab hosts `<webview>` guests (remote HTTP(S) only).
      webviewTag: true,
    },
  })
  mainWindow.once("ready-to-show", () => {
    if (backgroundLaunch) ensureTray()
    else mainWindow?.show()
    refreshTray()
  })
  mainWindow.on("close", (event) => {
    if (!quitting && hasBackgroundTasks()) {
      event.preventDefault()
      mainWindow?.hide()
      ensureTray()
      if (!trayHintShown) {
        trayHintShown = true
        showNotification(
          "OpenOrch sigue en segundo plano",
          "Hay tareas programadas activas. OpenOrch seguirá abierto en la bandeja para ejecutarlas.",
        )
      }
      return
    }
    dockBrowser.dispose()
    extensionBridge?.dispose()
  })
  mainWindow.on("closed", () => {
    mainWindow = undefined
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  // --- webview policy: guests never inherit the app preload; they get a minimal
  //     shortcut-forwarding preload and only our own partitions. ---
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const prefs = webPreferences as Record<string, unknown>
    delete prefs.preloadURL
    delete prefs.preloadURLAbsolute
    // Electron documents that the partition lives in webPreferences, not params.
    const partition = prefs.partition ?? (params as { partition?: string }).partition
    if (typeof partition !== "string" || !partition.startsWith("persist:openorch-web")) {
      event.preventDefault()
      return
    }
    prefs.preload = path.join(import.meta.dirname, "../preload/guest.cjs")
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.webSecurity = true
  })
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    // No permission prompts inside preview pages; guests stay http(s)-only.
    guest.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    guest.session.setPermissionCheckHandler(() => false)
    guest.on("will-navigate", (event, url) => {
      if (!/^https?:/i.test(url)) event.preventDefault()
    })
    // window.open inside a preview opens a new dock browser tab instead of a popup window.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) mainWindow?.webContents.send("browser:openTab", { url })
      return { action: "deny" }
    })
  })
  // Dock shortcuts pressed inside a preview (guest preload) are routed to the app window.
  ipcMain.on("openorch:guest-dock-shortcut", (event, payload: { key?: string; alt?: boolean; shift?: boolean }) => {
    if (event.sender.getType() !== "webview") return
    if (!payload || typeof payload.key !== "string") return
    mainWindow?.webContents.send("dock:shortcut", { key: payload.key, alt: Boolean(payload.alt), shift: Boolean(payload.shift) })
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"))
  }
}

function registerIpc(): void {
  const handle = (method: string, fn: (...args: never[]) => unknown) => {
    ipcMain.handle(`openorch:${method}`, async (_event, ...args) => fn(...(args as never[])))
  }

  handle("config.get", () => engine.getConfig())
  handle("config.set", (patch) => engine.setConfig(patch as never))
  // Clipboard lives in the main process: sandboxed preloads cannot import it.
  handle("clipboard.readText", () => clipboard.readText())
  handle("clipboard.writeText", (text: string) => clipboard.writeText(text))
  handle("providers.list", () => engine.listProviders())
  handle("providers.test", (providerID: string, draft?: { apiKey?: string; baseURL?: string }) =>
    engine.testProvider(providerID, draft),
  )
  handle("providers.disconnect", (providerID: string) => engine.disconnectProvider(providerID))
  handle("providers.refreshModels", (providerID: string) => engine.refreshProviderModels(providerID))
  handle("models.list", () => engine.listModels())
  handle("models.recent", () => engine.modelPreferences())
  handle("models.refreshCatalog", () => engine.refreshModelsCatalog())
  handle("models.catalogStatus", () => engine.catalogStatus())
  handle("agents.list", () => engine.listAgents())

  handle("sessions.list", () => engine.listSessions())
  handle("sessions.watch", (sessionID?: unknown) => {
    watchedSessionID = typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
  })
  handle("sessions.create", (input) => engine.createSession(input as never))
  handle("sessions.delete", (sessionID: string) => engine.deleteSession(sessionID))
  handle("sessions.rename", (sessionID: string, title: string) => engine.renameSession(sessionID, title))
  handle("sessions.setAgent", (sessionID: string, agent: string) => engine.setSessionAgent(sessionID, agent))
  handle("sessions.setModel", (sessionID: string, model: ModelRef) => engine.setSessionModel(sessionID, model))
  handle("sessions.messages", (sessionID: string) => engine.messages(sessionID))
  handle("sessions.prompt", (sessionID: string, input: PromptInput) => engine.prompt(sessionID, input))
  handle("sessions.command", (sessionID: string, command: string) => engine.command(sessionID, command))
  handle("sessions.interrupt", (sessionID: string) => engine.interrupt(sessionID))
  handle("sessions.compact", (sessionID: string) => engine.compact(sessionID))
  handle("sessions.busy", (sessionID: string) => engine.isBusy(sessionID))
  handle("session.directory", (sessionID: string) => engine.sessionDirectory(sessionID))

  handle("permissions.list", (sessionID?: string) => engine.pendingPermissions(sessionID))
  handle("permissions.reply", (requestID: string, reply: PermissionReply, message?: string) =>
    engine.replyPermission(requestID, reply, message),
  )
  handle("permissions.saved", () => engine.permissions.allSaved())
  handle("permissions.clearSaved", () => engine.permissions.clearSaved())
  handle("questions.reply", (requestID: string, answers: QuestionAnswer[]) => engine.replyQuestion(requestID, answers))

  handle("files.search", (sessionID: string, query: string, limit?: number) => engine.searchFiles(sessionID, query, limit))
  handle("skills.list", (sessionID?: string) => engine.skillsFor(sessionID ?? ""))
  handle("skills.read", (sessionID: string, id: string) => engine.readSkill(sessionID, id) ?? null)
  handle("skills.save", (sessionID: string, draft: { id: string; name?: string; description?: string; content: string }) =>
    engine.saveSkill(sessionID, draft),
  )
  handle("skills.install", (draft: { id: string; name?: string; description?: string; content: string }) => engine.installSkill(draft))
  handle("skills.remove", (id: string) => engine.removeSkill(id))
  handle("skills.importPick", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return engine.importSkillDraft(result.filePaths[0]) ?? null
  })
  handle("files.pick", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        { name: "All files", extensions: ["*"] },
      ],
    })
    if (result.canceled) return []
    const { readFileSync, statSync } = await import("node:fs")
    const { basename, extname } = await import("node:path")
    const mimeByExt: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".ts": "text/plain",
      ".js": "text/plain",
    }
    return result.filePaths.map((filePath) => {
      const mime = mimeByExt[extname(filePath).toLowerCase()] ?? "application/octet-stream"
      const size = statSync(filePath).size
      const entry: { path: string; name: string; mime: string; dataUrl?: string; size: number } = {
        path: filePath,
        name: basename(filePath),
        mime,
        size,
      }
      if (size <= 15 * 1024 * 1024) {
        entry.dataUrl = `data:${mime};base64,${readFileSync(filePath).toString("base64")}`
      }
      return entry
    })
  })
  handle("directory.pick", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle("terminal.shells", () => availableShells().map((shell) => ({ id: shell.id, name: shell.name, path: shell.path })))
  handle("terminal.list", () => engine.terminal.list())
  handle("terminal.open", async (sessionID: string, cols: number, rows: number, shellID?: string) => {
    const id = `term_${Date.now().toString(36)}`
    const cwd = engine.sessionDirectory(sessionID)
    try {
      await engine.terminal.open({
        id,
        cwd,
        cols,
        rows,
        shell: shellID,
        onData: (data) => send("terminal:data", { id, data }),
        onExit: () => send("terminal:exit", { id }),
      })
      return { id }
    } catch (error) {
      return { id: "", error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle("terminal.write", (id: string, data: string) => engine.terminal.write(id, data))
  handle("terminal.resize", (id: string, cols: number, rows: number) => engine.terminal.resize(id, cols, rows))
  handle("terminal.close", (id: string) => engine.terminal.close(id))

  handle("mcp.status", () => engine.mcp.status())
  handle("mcp.authenticate", (name: string) => engine.mcpAuthenticate(name))
  handle("mcp.logout", (name: string) => engine.mcpLogout(name))
  // The renderer registers the dock `<webview>` guest it just created; the agent
  // tools then drive that same guest through CDP (see main/browser.ts).
  handle("browser.register", (tabID: string, webContentsID: number) => dockBrowser.attach(tabID, webContentsID))
  handle("browser.unregister", (tabID: string) => dockBrowser.detach(tabID))
  handle("browser.extensionInfo", async () => {
    if (extensionBridge?.connected) await extensionBridge.refreshTabs().catch(() => undefined)
    const info = extensionBridge?.info
    return {
      mode: engine.getConfig().browser?.mode ?? "auto",
      connected: info?.connected ?? false,
      port: info?.port ?? 0,
      token: info?.token ?? "",
      browser: info?.browser ?? "",
      version: info?.version ?? "",
      lastError: info?.lastError ?? "",
      tabs: info?.tabs ?? [],
      extensionPath: extensionFolder(),
    }
  })
  handle("browser.extensionDisconnect", () => extensionBridge?.disconnect())
  handle("browser.extensionReset", () => extensionBridge?.resetToken() ?? "")
  handle("browser.extensionOpenFolder", async () => {
    const folder = extensionFolder()
    const error = await shell.openPath(folder)
    return error || null
  })
  handle("schedule.list", () => engine.schedule.list())
  handle("schedule.view", (taskID: string) => engine.schedule.view(taskID) ?? null)
  handle("schedule.create", (draft) => engine.schedule.create(draft as never))
  handle("schedule.update", (taskID: string, patch) => engine.schedule.update(taskID, patch as never))
  handle("schedule.remove", (taskID: string) => engine.schedule.remove(taskID))
  handle("schedule.setEnabled", (taskID: string, enabled: boolean) => engine.schedule.setEnabled(taskID, enabled))
  handle("schedule.runNow", (taskID: string) => engine.schedule.runNow(taskID))
  handle("schedule.clarify", (input) => engine.schedule.clarify(input as never))
  handle("schedule.runs", (taskID: string) => engine.schedule.runs(taskID))
  handle("schedule.startup", async (enabled: boolean) => {
    await engine.setConfig({ schedule: { startWithWindows: enabled } })
    applyLoginItem(enabled)
    return { openAtLogin: enabled }
  })
  handle("schedule.startupStatus", () => ({ openAtLogin: engine.getConfig().schedule.startWithWindows }))
  handle("app.version", () => app.getVersion())
  handle("app.paths", () => ({ home: app.getPath("home"), userData: app.getPath("userData") }))
  handle("path.isDirectory", (target: string) => {
    try {
      return statSync(target).isDirectory()
    } catch {
      return false
    }
  })
  handle("shell.openExternal", (url: string) => shell.openExternal(url))
}

// Single instance: a second launch would share userData (GPU cache, LevelDB) and the
// SQLite database with the first one, which crashed Electron with code 255. Focus the
// existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.log("[main] another OpenOrch instance is already running; focusing it and exiting.")
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // Keep crash diagnostics visible in the terminal that launched the app.
  app.on("render-process-gone", (_event, _contents, details) => {
    console.error("[main] renderer process gone:", JSON.stringify(details))
  })
  app.on("child-process-gone", (_event, details) => {
    console.error("[main] child process gone:", JSON.stringify(details))
  })

  app.whenReady().then(async () => {
    const dataDir = process.env.OPENORCH_DATA_DIR ?? path.join(app.getPath("userData"), "data")
    extensionBridge = new ExtensionBridge(dataDir)
    await extensionBridge.start().then(
      (port) => console.log(`[browser] extension bridge listening on ws://127.0.0.1:${port}`),
      (error) => console.error("[browser] extension bridge failed:", error),
    )
    const extensionBrowser = new ExtensionBrowser(extensionBridge)
    const browserRouter = new BrowserRouter(
      dockBrowser,
      extensionBrowser,
      extensionBridge,
      () => engine?.getConfig().browser?.mode ?? "auto",
    )
    engine = new Engine({
      dataDir,
      projectDirectory: process.env.OPENORCH_DIR ?? app.getPath("home"),
      emit: (event: EngineEvent) => {
        handleEngineEvent(event)
        // Background scheduled runs can produce thousands of deltas/tool updates.
        // Keep them out of IPC/renderer work unless that session is on screen.
        if (isTranscriptEvent(event) && "sessionID" in event && event.sessionID !== watchedSessionID) return
        send("engine:event", event)
      },
      log: (message) => console.log(`[engine] ${message}`),
      // MCP OAuth: the browser opens in the user's default browser.
      openUrl: (url) => void shell.openExternal(url),
      browser: browserRouter,
    })
    await engine.init()
    engine.projectDirectory = resolveProjectDirectory()
    applyLoginItem(engine.getConfig().schedule.startWithWindows)
    registerIpc()
    await createWindow()
    void syncBackgroundMode()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on("window-all-closed", () => {
  app.quit()
})

app.on("before-quit", () => {
  quitting = true
  destroyTray()
  dockBrowser.dispose()
  extensionBridge?.dispose()
  void engine?.shutdown?.()
})

process.on("uncaughtException", (error) => {
  console.error("[main] uncaught exception:", error)
})

process.on("unhandledRejection", (error) => {
  console.error("[main] unhandled rejection:", error)
})
