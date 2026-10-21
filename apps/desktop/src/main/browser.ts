import { randomUUID } from "node:crypto"
import { webContents, type WebContents } from "electron"
import type { BrowserService, BrowserSnapshot, BrowserTabInfo } from "@openorch/core"

/**
 * CDP-backed controller for the `<webview>` guests of the right-dock browser.
 *
 * The renderer registers each guest after `dom-ready` (tab id + webContents id);
 * every operation below runs on that guest through `webContents.debugger`, so the
 * agent never gets Node or Electron APIs, only DOM-level actions on the page.
 */

interface Attachment {
  id: string
  wc: WebContents
  /** Snapshot refs (`e12`) valid until the next snapshot or navigation. */
  refs: Map<string, number>
  cdp: boolean
}

interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
  description?: { value?: string }
  backendDOMNodeId?: number
  childIds?: string[]
}

/** Roles the agent can act on; only these get a `ref`. */
const INTERACTIVE = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
  "textbox",
  "treeitem",
  "gridcell",
  "columnheader",
  "rowheader",
])

const KEY_CODES: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32 },
}

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertHttp(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`[browser.invalid_url] "${url}" is not an absolute URL.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[browser.invalid_url] Only http(s) URLs are allowed, got ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error("[browser.invalid_url] URLs with credentials are not allowed.")
  }
}

export class DockBrowser implements BrowserService {
  private tabs = new Map<string, Attachment>()
  private waiters = new Map<string, { resolve: (tab: Attachment) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private send: (channel: string, payload: unknown) => void) {}

  // -------------------------------------------------------------------------
  // Renderer registration
  // -------------------------------------------------------------------------

  attach(tabID: string, webContentsID: number): void {
    const wc = webContents.fromId(webContentsID) ?? webContents.getAllWebContents().find((entry) => entry.id === webContentsID)
    if (!wc || wc.isDestroyed()) throw new Error(`[browser.attach] Unknown webContents ${webContentsID}.`)
    if (wc.getType() !== "webview") throw new Error("[browser.attach] Only webview guests can be controlled.")
    const existing = this.tabs.get(tabID)
    if (existing && existing.wc.id === wc.id) return
    if (existing) this.unattach(tabID)

    const tab: Attachment = { id: tabID, wc, refs: new Map(), cdp: false }
    this.tabs.set(tabID, tab)
    // Element refs never survive a document change.
    wc.on("did-navigate", () => tab.refs.clear())
    wc.on("did-navigate-in-page", () => tab.refs.clear())
    wc.on("destroyed", () => {
      if (this.tabs.get(tabID) === tab) this.tabs.delete(tabID)
    })
    const waiter = this.waiters.get(tabID)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.waiters.delete(tabID)
      waiter.resolve(tab)
    }
  }

  detach(tabID: string): void {
    this.unattach(tabID)
  }

  /** Detach every CDP session before the window closes (avoids slow/hung shutdowns). */
  dispose(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("[browser.open] The app is closing."))
    }
    this.waiters.clear()
    for (const tabID of [...this.tabs.keys()]) this.unattach(tabID)
  }

  private unattach(tabID: string): void {
    const tab = this.tabs.get(tabID)
    this.tabs.delete(tabID)
    if (!tab) return
    try {
      if (tab.cdp && tab.wc.debugger.isAttached()) tab.wc.debugger.detach()
    } catch {
      // The guest is already gone.
    }
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  list(): BrowserTabInfo[] {
    return [...this.tabs.values()].map((tab) => this.info(tab))
  }

  async open(url?: string): Promise<BrowserTabInfo> {
    if (url) assertHttp(url)
    const id = `tab_${randomUUID()}`
    const attached = new Promise<Attachment>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error("[browser.open] The desktop did not attach the new browser tab in time."))
      }, 15_000)
      this.waiters.set(id, { resolve, reject, timer })
    })
    this.send("browser:openTab", { id, url })
    let tab: Attachment
    try {
      tab = await attached
    } catch (error) {
      throw new Error(errorText(error))
    }
    await this.settle(tab, 20_000)
    return this.info(tab)
  }

  async close(tabID: string): Promise<BrowserTabInfo[]> {
    const tab = this.tab(tabID)
    this.send("browser:closeTab", { id: tabID })
    // The renderer unmounts the webview; wait briefly for the detach IPC.
    for (let i = 0; i < 40 && this.tabs.has(tabID); i++) await sleep(50)
    if (this.tabs.has(tabID)) this.unattach(tabID)
    void tab
    return this.list()
  }

  focus(tabID: string): BrowserTabInfo {
    const tab = this.tab(tabID)
    this.send("browser:focusTab", { id: tabID })
    return this.info(tab)
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  async navigate(tabID: string, url: string): Promise<BrowserTabInfo> {
    assertHttp(url)
    const tab = this.tab(tabID)
    tab.refs.clear()
    await this.load(tab, url)
    return this.info(tab)
  }

  async back(tabID: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    await this.history(tab, -1)
    return this.info(tab)
  }

  async forward(tabID: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    await this.history(tab, 1)
    return this.info(tab)
  }

  async reload(tabID: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    tab.refs.clear()
    tab.wc.reload()
    await this.settle(tab, 30_000)
    return this.info(tab)
  }

  private async load(tab: Attachment, url: string): Promise<void> {
    try {
      await tab.wc.loadURL(url)
    } catch (error) {
      // Redirects and aborted downloads surface as ERR_ABORTED; keep going when a page is there.
      const current = tab.wc.getURL()
      if (!/^https?:/i.test(current)) throw new Error(`[browser.navigate] ${errorText(error)}`)
    }
    await this.settle(tab, 30_000)
  }

  private async history(tab: Attachment, direction: -1 | 1): Promise<void> {
    const can = direction < 0 ? tab.wc.navigationHistory.canGoBack() : tab.wc.navigationHistory.canGoForward()
    if (!can) throw new Error(`[browser.history] There is no ${direction < 0 ? "previous" : "next"} page in this tab.`)
    tab.refs.clear()
    if (direction < 0) tab.wc.navigationHistory.goBack()
    else tab.wc.navigationHistory.goForward()
    await this.settle(tab, 30_000)
  }

  /** Wait until the page finished loading plus one frame, so actions see new content. */
  private async settle(tab: Attachment, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    // Give the navigation a beat to actually start (loadURL resolves early on redirects).
    await sleep(150)
    let idleSince = Date.now()
    while (Date.now() < deadline) {
      if (tab.wc.isLoading()) {
        idleSince = Date.now()
      } else if (Date.now() - idleSince >= 300) {
        return
      }
      await sleep(100)
    }
    throw new Error("[browser.timeout] The page did not finish loading in time.")
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  async snapshot(tabID: string, options: { maxChars?: number } = {}): Promise<BrowserSnapshot> {
    const tab = this.tab(tabID)
    const limit = Math.min(Math.max(options.maxChars ?? 12_000, 1_000), 40_000)
    tab.refs.clear()
    let nodes: AXNode[] = []
    try {
      await this.command(tab, "Accessibility.enable")
      const response = (await this.command(tab, "Accessibility.getFullAXTree")) as { nodes?: AXNode[] }
      nodes = response.nodes ?? []
    } catch (error) {
      console.error(`[browser] AX snapshot failed for ${tab.id}:`, error)
      nodes = []
    }

    const byId = new Map(nodes.map((node) => [node.nodeId, node]))
    const children = new Set<string>()
    for (const node of nodes) for (const childId of node.childIds ?? []) children.add(childId)
    const lines: string[] = []
    let used = 0
    let truncated = false
    let counter = 0

    const push = (line: string): boolean => {
      if (used + line.length + 1 > limit) {
        truncated = true
        return false
      }
      lines.push(line)
      used += line.length + 1
      return true
    }

    const walk = (node: AXNode | undefined, depth: number): boolean => {
      if (!node) return true
      // Ignored nodes still wrap real content (generic containers): recurse through
      // them without consuming a line or increasing the indent.
      if (node.ignored) {
        for (const childId of node.childIds ?? []) {
          if (!walk(byId.get(childId), depth)) return false
        }
        return true
      }
      const role = node.role?.value ?? ""
      const name = String(node.name?.value ?? "")
        .replaceAll(/\s+/g, " ")
        .trim()
      const value = node.value?.value
      let line = ""
      if (role && (name || INTERACTIVE.has(role) || role === "heading")) {
        let ref = ""
        if (node.backendDOMNodeId && (INTERACTIVE.has(role) || role === "heading")) {
          counter += 1
          ref = ` [ref=e${counter}]`
          tab.refs.set(`e${counter}`, node.backendDOMNodeId)
        }
        const shownName = name.length > 240 ? `${name.slice(0, 240)}…` : name
        const shownValue = value === undefined || value === null ? "" : ` value=${JSON.stringify(String(value).slice(0, 120))}`
        line = `${"  ".repeat(Math.min(depth, 18))}- ${role}${shownName ? ` ${JSON.stringify(shownName)}` : ""}${shownValue}${ref}`
      } else if (role === "StaticText" && name) {
        const shown = name.length > 300 ? `${name.slice(0, 300)}…` : name
        line = `${"  ".repeat(Math.min(depth, 18))}  ${JSON.stringify(shown)}`
      }
      if (line && !push(line)) return false
      if (depth > 40) return true
      for (const childId of node.childIds ?? []) {
        if (!walk(byId.get(childId), depth + 1)) return false
      }
      return true
    }

    const roots = nodes.filter((node) => !children.has(node.nodeId))
    for (const root of roots.length ? roots : nodes.slice(0, 1)) {
      if (!walk(root, 0)) break
    }

    let text = ""
    if (lines.length === 0) {
      try {
        text = String(await this.evaluateValue(tab, "document.body ? document.body.innerText : ''") ?? "")
          .replaceAll(/\n{3,}/g, "\n\n")
          .slice(0, 4_000)
      } catch {
        text = ""
      }
    }
    return { tab: this.info(tab), tree: lines.join("\n"), truncated, text }
  }

  async screenshot(tabID: string): Promise<{ tab: BrowserTabInfo; dataUrl: string }> {
    const tab = this.tab(tabID)
    const image = await tab.wc.capturePage()
    const png = image.toPNG()
    if (png.length === 0) throw new Error("[browser.screenshot] The tab is not visible; bring it to the front first.")
    return { tab: this.info(tab), dataUrl: `data:image/png;base64,${png.toString("base64")}` }
  }

  async evaluate(tabID: string, script: string): Promise<{ tab: BrowserTabInfo; value: unknown }> {
    const tab = this.tab(tabID)
    const value = await this.evaluateValue(tab, script)
    return { tab: this.info(tab), value }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  async click(tabID: string, ref: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const objectId = await this.resolve(tab, ref)
    const point = (await this.call(tab, objectId, "function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }")) as {
      x: number
      y: number
      w: number
      h: number
    }
    if (!point || !Number.isFinite(point.x) || point.w < 1 || point.h < 1) {
      // Hidden or zero-size element: fall back to the DOM click so React listeners still run.
      await this.call(tab, objectId, "function(){ this.click(); return true; }")
    } else {
      await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
      await this.command(tab, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
      await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
    }
    await this.settle(tab, 15_000)
    return this.info(tab)
  }

  async hover(tabID: string, ref: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const objectId = await this.resolve(tab, ref)
    const point = (await this.call(tab, objectId, "function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }")) as {
      x: number
      y: number
    }
    if (point && Number.isFinite(point.x)) {
      await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
      await sleep(250)
    }
    return this.info(tab)
  }

  async fill(tabID: string, ref: string, text: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const objectId = await this.resolve(tab, ref)
    const result = (await this.call(
      tab,
      objectId,
      `function(value){
        const el = this;
        el.focus();
        if (el.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          if (!document.execCommand('insertText', false, value)) el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
          return true;
        }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }`,
      [text],
    )) as boolean | undefined
    if (result === false) throw new Error(`[browser.fill] ${ref} is not an editable field.`)
    return this.info(tab)
  }

  async select(tabID: string, ref: string, values: string[]): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const objectId = await this.resolve(tab, ref)
    const result = (await this.call(
      tab,
      objectId,
      `function(values){
        if (!(this instanceof HTMLSelectElement)) return { error: 'not-select' };
        const options = Array.from(this.options);
        const chosen = [];
        for (const value of values) {
          const match = options.find((option) => option.value === value || (option.label || '').trim() === value) ??
            options[Number(value)];
          if (!match) return { error: 'no-option', value, available: options.slice(0, 20).map((option) => option.value) };
          match.selected = true;
          chosen.push(match.value);
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { chosen };
      }`,
      [values],
    )) as { error?: string; value?: string; available?: string[] } | undefined
    if (result?.error === "not-select") throw new Error(`[browser.select] ${ref} is not a <select> element.`)
    if (result?.error === "no-option") {
      throw new Error(`[browser.select] No option "${result.value}". Available values: ${(result.available ?? []).join(", ")}`)
    }
    return this.info(tab)
  }

  async check(tabID: string, ref: string, checked: boolean): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const objectId = await this.resolve(tab, ref)
    await this.call(
      tab,
      objectId,
      "function(checked){ if (this.checked !== undefined && this.checked !== checked) this.click(); else if (this.getAttribute('aria-checked') !== null && (this.getAttribute('aria-checked') === 'true') !== checked) this.click(); return true; }",
      [checked],
    )
    await this.settle(tab, 10_000)
    return this.info(tab)
  }

  async press(tabID: string, combo: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    const parts = combo.split("+").map((part) => part.trim()).filter(Boolean)
    const keyName = parts.pop() ?? ""
    let modifiers = 0
    for (const part of parts) modifiers |= MODIFIERS[part] ?? 0
    const mapped = KEY_CODES[keyName] ?? KEY_CODES[keyName.length === 1 ? keyName.toUpperCase() === " " ? "Space" : keyName : ""]
    let key = keyName
    let code = ""
    let vk = 0
    let text: string | undefined
    if (mapped) {
      key = mapped.key
      code = mapped.code
      vk = mapped.vk
      if (mapped.key === " ") text = " "
    } else if (keyName.length === 1) {
      const upper = keyName.toUpperCase()
      vk = upper.charCodeAt(0)
      code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : ""
      text = modifiers & MODIFIERS.Shift ? upper : keyName
    } else {
      throw new Error(`[browser.press] Unsupported key "${keyName}". Use Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space or a single character.`)
    }
    await this.command(tab, "Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
      ...(text ? { text } : {}),
    })
    await this.command(tab, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    })
    await sleep(150)
    await this.settle(tab, 15_000)
    return this.info(tab)
  }

  async scroll(tabID: string, deltaY: number, ref?: string): Promise<BrowserTabInfo> {
    const tab = this.tab(tabID)
    if (ref) {
      const objectId = await this.resolve(tab, ref)
      await this.call(tab, objectId, "function(){ this.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); return true; }")
      await sleep(200)
      return this.info(tab)
    }
    const viewport = (await this.evaluateValue(tab, "({ width: window.innerWidth, height: window.innerHeight })")) as {
      width?: number
      height?: number
    }
    const x = Math.round((viewport?.width ?? 800) / 2)
    const y = Math.round((viewport?.height ?? 600) / 2)
    await this.command(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY })
    await sleep(350)
    return this.info(tab)
  }

  async wait(tabID: string, options: { text?: string; timeoutMs: number }): Promise<{ tab: BrowserTabInfo; matched: boolean }> {
    const tab = this.tab(tabID)
    const deadline = Date.now() + Math.min(Math.max(options.timeoutMs, 100), 30_000)
    let matched = false
    while (Date.now() < deadline) {
      try {
        if (options.text) {
          matched = Boolean(
            await this.evaluateValue(tab, `document.body ? document.body.innerText.includes(${JSON.stringify(options.text)}) : false`),
          )
        } else {
          matched = !tab.wc.isLoading() && (await this.evaluateValue(tab, "document.readyState")) === "complete"
        }
      } catch {
        matched = false
      }
      if (matched) break
      await sleep(250)
    }
    return { tab: this.info(tab), matched }
  }

  // -------------------------------------------------------------------------
  // CDP helpers
  // -------------------------------------------------------------------------

  private tab(tabID: string): Attachment {
    const tab = this.tabs.get(tabID)
    if (!tab) {
      const open = this.list()
      throw new Error(
        `[browser.tab_unavailable] Tab "${tabID}" is not attached. ${
          open.length ? `Open tabs: ${open.map((entry) => `${entry.id} (${entry.url})`).join(", ")}.` : "No tabs are open; open one first."
        }`,
      )
    }
    if (tab.wc.isDestroyed()) {
      this.tabs.delete(tabID)
      throw new Error(`[browser.tab_unavailable] Tab "${tabID}" was closed. Open a new tab.`)
    }
    return tab
  }

  private info(tab: Attachment): BrowserTabInfo {
    let url = ""
    let title = ""
    try {
      url = tab.wc.getURL()
      title = tab.wc.getTitle()
    } catch {
      // Guest tearing down.
    }
    return { id: tab.id, url, title }
  }

  private async command(tab: Attachment, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try {
      if (!tab.wc.debugger.isAttached()) {
        tab.wc.debugger.attach("1.3")
        tab.cdp = true
      }
      return await tab.wc.debugger.sendCommand(method, params)
    } catch (error) {
      const message = errorText(error)
      if (/not attached|detached/i.test(message)) {
        try {
          tab.wc.debugger.attach("1.3")
          tab.cdp = true
          return await tab.wc.debugger.sendCommand(method, params)
        } catch (retry) {
          throw new Error(`[browser.cdp] ${errorText(retry)}`)
        }
      }
      throw new Error(`[browser.cdp] ${message}`)
    }
  }

  private async resolve(tab: Attachment, ref: string): Promise<string> {
    const key = ref.replace(/^@/, "")
    const backendNodeId = tab.refs.get(key)
    if (!backendNodeId) {
      throw new Error(`[browser.stale_ref] Ref ${ref} is not in the latest snapshot of this tab. Take a new snapshot and use one of its refs.`)
    }
    const response = (await this.command(tab, "DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string }
    }
    const objectId = response.object?.objectId
    if (!objectId) throw new Error(`[browser.stale_ref] Ref ${ref} no longer exists in the page. Take a new snapshot.`)
    return objectId
  }

  private async call(tab: Attachment, objectId: string, fn: string, args: unknown[] = []): Promise<unknown> {
    const response = (await this.command(tab, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "page script failed"
      throw new Error(`[browser.action] ${detail}`)
    }
    return response.result?.value
  }

  private async evaluateValue(tab: Attachment, expression: string): Promise<unknown> {
    const response = (await this.command(tab, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "page script failed"
      throw new Error(`[browser.evaluate] ${detail}`)
    }
    return response.result?.value
  }
}
