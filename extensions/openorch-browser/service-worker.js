/*
 * OpenOrch Browser — MV3 service worker.
 *
 * Connects to the local OpenOrch bridge (127.0.0.1) over WebSocket and executes
 * browser operations only on tabs inside the "OpenOrch" tab group. All page
 * access uses chrome.debugger (CDP), so OpenOrch never needs content scripts.
 */

const GROUP_TITLE = "OpenOrch"
const GROUP_COLOR = "blue"
const TAB_PREFIX = "edge:"
const DEFAULT_SERVER = "ws://127.0.0.1:45871"
const DEFAULT_MAX_CHARS = 12_000
const MAX_SNAPSHOT_CHARS = 40_000

const INTERACTIVE = new Set([
  "link", "button", "checkbox", "radio", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
  "spinbutton", "searchbox", "textbox", "treeitem", "gridcell", "columnheader", "rowheader",
])

const KEY_CODES = {
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
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

let socket = null
let enabled = false
let serverUrl = DEFAULT_SERVER
let token = ""
let groupID = null
let reconnectTimer = null
let reconnectDelay = 1500
let statusState = "idle"
let lastError = ""
let tabsTimer = null

const attached = new Set()
const refsByTab = new Map()
const queues = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

function setStatus(state, error = "") {
  statusState = state
  lastError = error
  try {
    chrome.runtime.sendMessage({ type: "status-update", state, error }).catch(() => undefined)
  } catch {
    // No popup open.
  }
}

// ---------------------------------------------------------------------------
// Settings / connection
// ---------------------------------------------------------------------------

async function loadSettings() {
  const data = await chrome.storage.local.get(["enabled", "serverUrl", "token", "groupId"])
  enabled = data.enabled === true && typeof data.token === "string" && data.token.length > 0
  serverUrl = typeof data.serverUrl === "string" && data.serverUrl ? data.serverUrl : DEFAULT_SERVER
  token = typeof data.token === "string" ? data.token : ""
  groupID = typeof data.groupId === "number" ? data.groupId : null
}

function sendRaw(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // The close handler reconnects.
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  if (!enabled || !token) return
  reconnectTimer = setTimeout(() => {
    void connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 15_000)
}

async function connect() {
  if (!enabled || !token) {
    setStatus("unpaired")
    return
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  clearTimeout(reconnectTimer)
  setStatus("connecting")
  let next
  try {
    next = new WebSocket(serverUrl)
  } catch (error) {
    setStatus("disconnected", errorMessage(error))
    scheduleReconnect()
    return
  }
  socket = next
  next.onopen = () => {
    reconnectDelay = 1500
    setStatus("connected")
    sendRaw({
      type: "hello",
      token,
      version: chrome.runtime.getManifest().version,
      browser: (self.navigator && self.navigator.userAgent) || "Edge",
    })
    void sendTabsNow()
  }
  next.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    handleHostMessage(message)
  }
  next.onerror = () => {
    try {
      next.close()
    } catch {
      // Ignore.
    }
  }
  next.onclose = () => {
    if (socket === next) socket = null
    if (statusState !== "unpaired") setStatus("disconnected")
    scheduleReconnect()
  }
}

async function disconnect(save = true) {
  enabled = false
  clearTimeout(reconnectTimer)
  if (save) await chrome.storage.local.set({ enabled: false })
  try {
    socket?.close()
  } catch {
    // Ignore.
  }
  socket = null
  setStatus("unpaired")
  await stopAll()
}

function handleHostMessage(message) {
  if (!message || typeof message !== "object") return
  if (message.type === "ping") {
    sendRaw({ type: "pong" })
    return
  }
  if (message.type === "unauthorized") {
    enabled = false
    void chrome.storage.local.set({ enabled: false })
    setStatus("unpaired", "Código de conexión rechazado. Revisa Ajustes → Navegador en OpenOrch.")
    try {
      socket?.close()
    } catch {
      // Ignore.
    }
    socket = null
    return
  }
  if (message.type === "disable") {
    void disconnect(true)
    return
  }
  if (message.type === "stop") {
    void stopAll()
    return
  }
  if (message.type === "call" && typeof message.id === "string") {
    void handleCall(message)
  }
}

async function handleCall(message) {
  const op = typeof message.op === "string" ? message.op : ""
  const args = message.args && typeof message.args === "object" ? message.args : {}
  try {
    const result = await enqueueFor(op, args, () => runOp(op, args))
    sendRaw({ type: "result", id: message.id, ok: true, result })
  } catch (error) {
    sendRaw({ type: "result", id: message.id, ok: false, error: `[browser.extension] ${errorMessage(error)}` })
  }
}

function enqueueFor(op, args, run) {
  if (!args.tabID || ["list", "open", "stop"].includes(op)) return run()
  const key = String(args.tabID)
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  queues.set(key, next)
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  }).catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Tab group
// ---------------------------------------------------------------------------

function tabInfo(tab) {
  return { id: `${TAB_PREFIX}${tab.id}`, url: tab.url || tab.pendingUrl || "", title: tab.title || "" }
}

function parseTabID(value) {
  const numeric = Number(String(value || "").replace(TAB_PREFIX, ""))
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`[browser.tab_unavailable] Invalid tab id "${value}". Call tabs_list again.`)
  }
  return numeric
}

async function currentGroupID() {
  if (groupID !== null) {
    try {
      await chrome.tabGroups.get(groupID)
      return groupID
    } catch {
      groupID = null
    }
  }
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE })
  if (groups.length > 0) {
    groupID = groups[0].id
    await chrome.storage.local.set({ groupId: groupID })
    return groupID
  }
  return null
}

async function groupTabs() {
  const id = await currentGroupID()
  if (id === null) return []
  return chrome.tabs.query({ groupId: id })
}

async function addToGroup(tabId) {
  let id = await currentGroupID()
  if (id === null) {
    id = await chrome.tabs.group({ tabIds: [tabId] })
    await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: GROUP_COLOR })
  } else {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== id) await chrome.tabs.group({ tabIds: [tabId], groupId: id })
  }
  groupID = id
  await chrome.storage.local.set({ groupId: id })
  scheduleTabs()
  return id
}

async function listTabs() {
  return (await groupTabs()).map(tabInfo)
}

/** Only tabs in the OpenOrch group can be read or driven. */
async function requireGrouped(tabId) {
  const id = await currentGroupID()
  if (id === null) throw new Error("[browser.tab_unavailable] No OpenOrch tab group exists. Use tabs_open first.")
  const tab = await chrome.tabs.get(tabId)
  if (tab.groupId !== id) {
    throw new Error("[browser.tab_unavailable] That tab is not in the OpenOrch tab group. Use tabs_list/tabs_open.")
  }
  return tab
}

async function groupedTabID(value) {
  const id = parseTabID(value)
  await requireGrouped(id)
  return id
}

function scheduleTabs() {
  clearTimeout(tabsTimer)
  tabsTimer = setTimeout(() => {
    void sendTabsNow()
  }, 250)
}

async function sendTabsNow() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  try {
    sendRaw({ type: "tabs", tabs: await listTabs() })
  } catch {
    // The bridge will ask again on reconnect.
  }
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const error = chrome.runtime.lastError
      if (error && !/already attached/i.test(error.message)) reject(new Error(error.message))
      else resolve()
    })
  })
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError
        resolve()
      })
    } catch {
      resolve()
    }
  })
}

function debuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve(result)
    })
  })
}

async function attach(tabId) {
  if (attached.has(tabId)) {
    try {
      await chrome.tabs.get(tabId)
      return
    } catch {
      attached.delete(tabId)
    }
  }
  await debuggerAttach(tabId)
  attached.add(tabId)
  try {
    await debuggerCommand(tabId, "Page.enable")
  } catch {
    // Page domain is optional; actions still work.
  }
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId)
  try {
    return await debuggerCommand(tabId, method, params)
  } catch (error) {
    if (!/not attached|detached/i.test(errorMessage(error))) throw error
    attached.delete(tabId)
    await attach(tabId)
    return debuggerCommand(tabId, method, params)
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  refsByTab.delete(tabId)
  await debuggerDetach(tabId)
}

async function stopAll() {
  const ids = [...attached]
  for (const id of ids) await detach(id)
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attached.delete(source.tabId)
    refsByTab.delete(source.tabId)
  }
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return
  if (method === "Page.javascriptDialogOpening") {
    // Never let a native dialog freeze the agent; confirmations are dismissed.
    const type = params?.type
    const accept = type === "alert" || type === "beforeunload"
    chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", { accept }, () => {
      void chrome.runtime.lastError
    })
  }
})

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function evalJs(tabId, expression) {
  const response = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "page script failed"
    throw new Error(detail)
  }
  return response?.result?.value
}

async function tabComplete(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab.status === "complete"
  } catch {
    return true
  }
}

async function settle(tabId, timeoutMs = 15_000) {
  await sleep(150)
  const deadline = Date.now() + timeoutMs
  let idleSince = Date.now()
  while (Date.now() < deadline) {
    const complete = await tabComplete(tabId)
    let ready = "complete"
    try {
      ready = await evalJs(tabId, "document.readyState")
    } catch {
      // The frame may be navigating.
    }
    if (complete && ready === "complete") {
      if (Date.now() - idleSince >= 350) return
    } else {
      idleSince = Date.now()
    }
    await sleep(120)
  }
  throw new Error("[browser.timeout] The page did not finish loading in time.")
}

async function waitComplete(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tabComplete(tabId)) {
      await sleep(200)
      return
    }
    await sleep(150)
  }
  throw new Error("[browser.timeout] The page did not finish loading in time.")
}

async function navigateTo(tabId, url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("[browser.invalid_url] Only http(s) URLs are allowed.")
  refsByTab.delete(tabId)
  await chrome.tabs.update(tabId, { url })
  await waitComplete(tabId)
  await settle(tabId)
  return currentTab(tabId)
}

async function currentTab(tabId) {
  return tabInfo(await chrome.tabs.get(tabId))
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function snapshot(tabId, options = {}) {
  const limit = Math.min(Math.max(Number(options.maxChars) || DEFAULT_MAX_CHARS, 1_000), MAX_SNAPSHOT_CHARS)
  let nodes = []
  try {
    await cdp(tabId, "Accessibility.enable")
    const response = await cdp(tabId, "Accessibility.getFullAXTree")
    nodes = Array.isArray(response?.nodes) ? response.nodes : []
  } catch {
    nodes = []
  }

  const refs = new Map()
  refsByTab.set(tabId, refs)
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const children = new Set()
  for (const node of nodes) for (const childId of node.childIds || []) children.add(childId)

  const lines = []
  let used = 0
  let truncated = false
  let counter = 0

  const push = (line) => {
    if (used + line.length + 1 > limit) {
      truncated = true
      return false
    }
    lines.push(line)
    used += line.length + 1
    return true
  }

  const walk = (node, depth) => {
    if (!node) return true
    if (node.ignored) {
      for (const childId of node.childIds || []) if (!walk(byId.get(childId), depth)) return false
      return true
    }
    const role = node.role?.value || ""
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim()
    const value = node.value?.value
    let line = ""
    if (role && (name || INTERACTIVE.has(role) || role === "heading")) {
      let ref = ""
      if (node.backendDOMNodeId && (INTERACTIVE.has(role) || role === "heading")) {
        counter += 1
        ref = ` [ref=e${counter}]`
        refs.set(`e${counter}`, node.backendDOMNodeId)
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
    for (const childId of node.childIds || []) if (!walk(byId.get(childId), depth + 1)) return false
    return true
  }

  const roots = nodes.filter((node) => !children.has(node.nodeId))
  for (const root of roots.length ? roots : nodes.slice(0, 1)) {
    if (!walk(root, 0)) break
  }

  let text = ""
  if (lines.length === 0) {
    try {
      text = String((await evalJs(tabId, "document.body ? document.body.innerText : ''")) || "")
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 4_000)
    } catch {
      text = ""
    }
  }
  return { tab: await currentTab(tabId), tree: lines.join("\n"), truncated, text }
}

async function resolve(tabId, ref) {
  const key = String(ref || "").replace(/^@/, "").replace(/^ref_/, "")
  const backendNodeId = refsByTab.get(tabId)?.get(key)
  if (!backendNodeId) {
    throw new Error(`[browser.stale_ref] Ref ${ref} is not in the latest snapshot of this tab. Take a new snapshot.`)
  }
  const response = await cdp(tabId, "DOM.resolveNode", { backendNodeId })
  const objectId = response?.object?.objectId
  if (!objectId) throw new Error(`[browser.stale_ref] Ref ${ref} no longer exists. Take a new snapshot.`)
  return objectId
}

async function callOn(tabId, objectId, fn, args = []) {
  const response = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  })
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "page script failed"
    throw new Error(detail)
  }
  return response?.result?.value
}

// ---------------------------------------------------------------------------
// Input actions
// ---------------------------------------------------------------------------

async function click(tabId, ref) {
  const objectId = await resolve(tabId, ref)
  const point = await callOn(
    tabId,
    objectId,
    "function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }",
  )
  if (!point || !Number.isFinite(point.x) || point.w < 1 || point.h < 1) {
    await callOn(tabId, objectId, "function(){ this.click(); return true; }")
  } else {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
  }
  await settle(tabId)
  return currentTab(tabId)
}

async function hover(tabId, ref) {
  const objectId = await resolve(tabId, ref)
  const point = await callOn(
    tabId,
    objectId,
    "function(){ this.scrollIntoView({block:'center',inline:'center',behavior:'instant'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }",
  )
  if (point && Number.isFinite(point.x)) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
    await sleep(250)
  }
  return currentTab(tabId)
}

async function fill(tabId, ref, text) {
  const objectId = await resolve(tabId, ref)
  const result = await callOn(
    tabId,
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
    [String(text ?? "")],
  )
  if (result === false) throw new Error(`[browser.fill] ${ref} is not an editable field.`)
  await sleep(150)
  return currentTab(tabId)
}

async function select(tabId, ref, values) {
  const objectId = await resolve(tabId, ref)
  const result = await callOn(
    tabId,
    objectId,
    `function(values){
      if (!(this instanceof HTMLSelectElement)) return { error: 'not-select' };
      const options = Array.from(this.options);
      for (const value of values) {
        const match = options.find((option) => option.value === value || (option.label || '').trim() === value) ?? options[Number(value)];
        if (!match) return { error: 'no-option', value, available: options.slice(0, 20).map((option) => option.value) };
        match.selected = true;
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }`,
    [Array.isArray(values) ? values : [values]],
  )
  if (result?.error === "not-select") throw new Error(`[browser.select] ${ref} is not a <select> element.`)
  if (result?.error === "no-option") throw new Error(`[browser.select] No option "${result.value}".`)
  await sleep(150)
  return currentTab(tabId)
}

async function check(tabId, ref, checked) {
  const objectId = await resolve(tabId, ref)
  await callOn(
    tabId,
    objectId,
    "function(checked){ if (this.checked !== undefined && this.checked !== checked) this.click(); else if (this.getAttribute('aria-checked') !== null && (this.getAttribute('aria-checked') === 'true') !== checked) this.click(); return true; }",
    [Boolean(checked)],
  )
  await settle(tabId, 8_000)
  return currentTab(tabId)
}

async function press(tabId, combo) {
  const parts = String(combo || "").split("+").map((part) => part.trim()).filter(Boolean)
  const keyName = parts.pop() || ""
  let modifiers = 0
  for (const part of parts) modifiers |= MODIFIERS[part] || 0
  let mapped = KEY_CODES[keyName]
  if (!mapped && keyName.length === 1) {
    const upper = keyName.toUpperCase()
    mapped = { key: keyName, code: /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : "", vk: upper.charCodeAt(0), text: modifiers & MODIFIERS.Shift ? upper : keyName }
  }
  if (!mapped) throw new Error(`[browser.press] Unsupported key "${keyName}".`)
  const text = mapped.text || (mapped.key === " " ? " " : undefined)
  const body = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.vk,
    nativeVirtualKeyCode: mapped.vk,
    modifiers,
  }
  await cdp(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...body, ...(text ? { text } : {}) })
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...body })
  await sleep(150)
  await settle(tabId)
  return currentTab(tabId)
}

async function scroll(tabId, deltaY, ref) {
  if (ref) {
    const objectId = await resolve(tabId, ref)
    await callOn(tabId, objectId, "function(){ this.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); return true; }")
  } else {
    const viewport = (await evalJs(tabId, "({ width: window.innerWidth, height: window.innerHeight })")) || {}
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round((viewport.width || 800) / 2),
      y: Math.round((viewport.height || 600) / 2),
      deltaX: 0,
      deltaY: Number(deltaY) || 700,
    })
  }
  await sleep(350)
  return currentTab(tabId)
}

async function waitFor(tabId, text, timeoutMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 10_000, 100), 30_000)
  let matched = false
  while (Date.now() < deadline) {
    try {
      if (text) {
        matched = Boolean(await evalJs(tabId, `document.body ? document.body.innerText.includes(${JSON.stringify(String(text))}) : false`))
      } else {
        matched = (await tabComplete(tabId)) && (await evalJs(tabId, "document.readyState")) === "complete"
      }
    } catch {
      matched = false
    }
    if (matched) break
    await sleep(250)
  }
  return { tab: await currentTab(tabId), matched }
}

async function screenshot(tabId) {
  const response = await cdp(tabId, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false })
  if (!response?.data) throw new Error("[browser.screenshot] The page could not be captured. Bring the tab to the front and retry.")
  return { tab: await currentTab(tabId), dataUrl: `data:image/png;base64,${response.data}` }
}

async function evaluate(tabId, script) {
  return { tab: await currentTab(tabId), value: await evalJs(tabId, String(script || "")) }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function runOp(op, args) {
  switch (op) {
    case "list":
      return { tabs: await listTabs() }
    case "open": {
      const url = typeof args.url === "string" && args.url ? args.url : "about:blank"
      if (url !== "about:blank" && !/^https?:\/\//i.test(url)) throw new Error("[browser.invalid_url] Only http(s) URLs are allowed.")
      const tab = await chrome.tabs.create({ url, active: true })
      await addToGroup(tab.id)
      await waitComplete(tab.id)
      await settle(tab.id)
      return { tab: await currentTab(tab.id) }
    }
    case "close": {
      const tabId = await groupedTabID(args.tabID)
      await detach(tabId)
      await chrome.tabs.remove(tabId)
      scheduleTabs()
      return { tabs: await listTabs() }
    }
    case "focus": {
      const tabId = await groupedTabID(args.tabID)
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
      return { tab: tabInfo(tab) }
    }
    case "navigate":
      return { tab: await navigateTo(await groupedTabID(args.tabID), String(args.url || "")) }
    case "back": {
      const tabId = await groupedTabID(args.tabID)
      refsByTab.delete(tabId)
      if (typeof chrome.tabs.goBack === "function") await chrome.tabs.goBack(tabId)
      else await evalJs(tabId, "history.back(); true")
      await waitComplete(tabId)
      await settle(tabId)
      return { tab: await currentTab(tabId) }
    }
    case "forward": {
      const tabId = await groupedTabID(args.tabID)
      refsByTab.delete(tabId)
      if (typeof chrome.tabs.goForward === "function") await chrome.tabs.goForward(tabId)
      else await evalJs(tabId, "history.forward(); true")
      await waitComplete(tabId)
      await settle(tabId)
      return { tab: await currentTab(tabId) }
    }
    case "reload": {
      const tabId = await groupedTabID(args.tabID)
      refsByTab.delete(tabId)
      await chrome.tabs.reload(tabId)
      await waitComplete(tabId)
      await settle(tabId)
      return { tab: await currentTab(tabId) }
    }
    case "snapshot":
      return snapshot(await groupedTabID(args.tabID), args)
    case "click":
      return { tab: await click(await groupedTabID(args.tabID), String(args.ref || "")) }
    case "hover":
      return { tab: await hover(await groupedTabID(args.tabID), String(args.ref || "")) }
    case "fill":
      return { tab: await fill(await groupedTabID(args.tabID), String(args.ref || ""), args.text) }
    case "select":
      return { tab: await select(await groupedTabID(args.tabID), String(args.ref || ""), args.values) }
    case "check":
      return { tab: await check(await groupedTabID(args.tabID), String(args.ref || ""), Boolean(args.checked)) }
    case "press":
      return { tab: await press(await groupedTabID(args.tabID), String(args.key || "")) }
    case "scroll":
      return { tab: await scroll(await groupedTabID(args.tabID), args.deltaY, args.ref ? String(args.ref) : undefined) }
    case "wait":
      return waitFor(await groupedTabID(args.tabID), args.text ? String(args.text) : undefined, args.timeoutMs)
    case "screenshot":
      return screenshot(await groupedTabID(args.tabID))
    case "evaluate":
      return evaluate(await groupedTabID(args.tabID), args.script)
    case "stop":
      await stopAll()
      return {}
    case "ping":
      return { ok: true }
    default:
      throw new Error(`Unknown browser operation "${op}".`)
  }
}

// ---------------------------------------------------------------------------
// Browser events
// ---------------------------------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id && tab.openerTabId) {
    void (async () => {
      try {
        const id = await currentGroupID()
        if (id === null) return
        const opener = await chrome.tabs.get(tab.openerTabId)
        if (opener.groupId === id) await chrome.tabs.group({ tabIds: [tab.id], groupId: id })
        scheduleTabs()
      } catch {
        // Ignore.
      }
    })()
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  refsByTab.delete(tabId)
  scheduleTabs()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") refsByTab.delete(tabId)
  if (changeInfo.status || changeInfo.title || changeInfo.url || changeInfo.groupId !== undefined) scheduleTabs()
})

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.id === groupID) {
    groupID = null
    void chrome.storage.local.set({ groupId: null })
  }
})

// ---------------------------------------------------------------------------
// Popup messages / lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (!message || typeof message !== "object") return sendResponse({ ok: false })
    if (message.type === "status") {
      return sendResponse({
        ok: true,
        state: statusState,
        error: lastError,
        enabled,
        serverUrl,
        token,
        version: chrome.runtime.getManifest().version,
        browser: (self.navigator && self.navigator.userAgent) || "",
        tabs: await listTabs().catch(() => []),
      })
    }
    if (message.type === "connect") {
      const nextServer = typeof message.serverUrl === "string" && message.serverUrl ? message.serverUrl : DEFAULT_SERVER
      const nextToken = typeof message.token === "string" ? message.token.trim() : ""
      if (!nextToken) return sendResponse({ ok: false, error: "Falta el código de conexión." })
      await chrome.storage.local.set({ enabled: true, serverUrl: nextServer, token: nextToken })
      enabled = true
      serverUrl = nextServer
      token = nextToken
      clearTimeout(reconnectTimer)
      try {
        socket?.close()
      } catch {
        // Ignore.
      }
      socket = null
      await connect()
      return sendResponse({ ok: true })
    }
    if (message.type === "disconnect") {
      await disconnect(true)
      return sendResponse({ ok: true })
    }
    if (message.type === "stop") {
      await stopAll()
      return sendResponse({ ok: true })
    }
    if (message.type === "test-tab") {
      const tab = await chrome.tabs.create({ url: "https://example.com", active: true })
      await addToGroup(tab.id)
      return sendResponse({ ok: true, tab: tabInfo(tab) })
    }
    return sendResponse({ ok: false, error: "Mensaje desconocido." })
  })()
  return true
})

chrome.alarms.create("openorch-keepalive", { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "openorch-keepalive") return
  if (!enabled) return
  if (!socket || socket.readyState === WebSocket.CLOSED) void connect()
  else sendRaw({ type: "ping" })
})

chrome.runtime.onStartup.addListener(() => {
  void loadSettings().then(() => connect())
})

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().then(() => connect())
})

void loadSettings().then(() => connect())
