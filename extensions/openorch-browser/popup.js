const stateEl = document.getElementById("state")
const errorEl = document.getElementById("error")
const dotEl = document.getElementById("dot")
const serverEl = document.getElementById("server")
const tokenEl = document.getElementById("token")
const versionEl = document.getElementById("version")
const connectEl = document.getElementById("connect")
const disconnectEl = document.getElementById("disconnect")
const stopEl = document.getElementById("stop")
const testEl = document.getElementById("test")

let firstLoad = true
let busy = false

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
      else resolve(response || { ok: false, error: "Sin respuesta del service worker." })
    })
  })

function render(status) {
  if (!status || !status.ok) return
  if (firstLoad) {
    if (!serverEl.value && status.serverUrl) serverEl.value = status.serverUrl
    if (!tokenEl.value && status.token) tokenEl.value = status.token
    if (status.version) versionEl.textContent = `v${status.version}`
    firstLoad = false
  }
  const state = status.state || "disconnected"
  if (state === "connected") {
    stateEl.textContent = "Conectado a OpenOrch"
    dotEl.className = "dot ok"
    dotEl.title = "Conectado"
  } else if (state === "connecting") {
    stateEl.textContent = "Conectando…"
    dotEl.className = "dot warn"
    dotEl.title = "Conectando"
  } else if (state === "unpaired") {
    stateEl.textContent = status.enabled ? "Sin conexión" : "Sin conectar"
    dotEl.className = "dot warn"
    dotEl.title = "Sin conectar"
  } else {
    stateEl.textContent = status.enabled ? "Desconectado (reintentando…)" : "Desconectado"
    dotEl.className = "dot off"
    dotEl.title = "Desconectado"
  }
  const tabs = Array.isArray(status.tabs) ? status.tabs.length : 0
  if (state === "connected") stateEl.textContent = `Conectado a OpenOrch · ${tabs} pestaña${tabs === 1 ? "" : "s"}`
  if (status.error) {
    errorEl.textContent = status.error
    errorEl.classList.remove("hidden")
  } else {
    errorEl.classList.add("hidden")
  }
  connectEl.disabled = busy || state === "connected"
  disconnectEl.disabled = busy || (!status.enabled && state !== "connected")
  stopEl.disabled = busy
  testEl.disabled = busy
}

async function refresh() {
  render(await send({ type: "status" }))
}

async function act(button, message, after) {
  busy = true
  button.disabled = true
  const response = await send(message)
  busy = false
  if (!response?.ok) {
    errorEl.textContent = response?.error || "Error desconocido."
    errorEl.classList.remove("hidden")
  } else if (after) {
    after()
  }
  await refresh()
}

connectEl.addEventListener("click", () => {
  const serverUrl = serverEl.value.trim() || "ws://127.0.0.1:45871"
  const token = tokenEl.value.trim()
  if (!token) {
    errorEl.textContent = "Pega el código de conexión de OpenOrch (Ajustes → Navegador)."
    errorEl.classList.remove("hidden")
    return
  }
  void act(connectEl, { type: "connect", serverUrl, token })
})

disconnectEl.addEventListener("click", () => {
  void act(disconnectEl, { type: "disconnect" })
})

stopEl.addEventListener("click", () => {
  void act(stopEl, { type: "stop" })
})

testEl.addEventListener("click", () => {
  void act(testEl, { type: "test-tab" })
})

void refresh()
setInterval(() => void refresh(), 1000)
