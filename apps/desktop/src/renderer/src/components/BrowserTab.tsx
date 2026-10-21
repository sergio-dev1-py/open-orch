import { Show, createSignal, onCleanup, onMount } from "solid-js"
import type { DockTab } from "../store"
import { api } from "../api"
import { t } from "../i18n"
import { setDockTab } from "../store"
import { Icon } from "./Icons"

/** Minimal typing for the `<webview>` guest element (created imperatively). */
interface GuestEvent {
  url?: string
  title?: string
  isMainFrame?: boolean
  errorCode?: number
}

interface GuestView {
  addEventListener(type: string, listener: (event: GuestEvent) => void): void
  removeEventListener(type: string, listener: (event: GuestEvent) => void): void
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  isLoading(): boolean
  getWebContentsId(): number
}

/**
 * Address policy (mirrors DSH): http(s) only, a bare host becomes https://,
 * credentials/file:/data:/script: addresses are rejected.
 */
export function normalizeAddress(input: string): string | undefined {
  const raw = input.trim()
  if (!raw) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.username || url.password) return undefined
  return url.toString()
}

/** Browser tab: toolbar (← → ⟳ ↗) + an isolated `<webview>` guest. */
export function BrowserTab(props: { tab: DockTab; active: boolean }) {
  let host: HTMLDivElement | undefined
  let guest: GuestView | undefined
  const [address, setAddress] = createSignal(props.tab.url ?? "")
  const [lastURL, setLastURL] = createSignal(props.tab.url ?? "")
  const [hasPage, setHasPage] = createSignal(Boolean(props.tab.url))
  const [canBack, setCanBack] = createSignal(false)
  const [canForward, setCanForward] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")

  const syncHistory = () => {
    if (!guest) return
    try {
      setCanBack(guest.canGoBack())
      setCanForward(guest.canGoForward())
    } catch {
      // Guest not ready yet.
    }
  }

  /** The event payload varies across Electron versions: read the guest title directly. */
  const syncTitle = () => {
    if (!guest) return
    try {
      const title = (guest.getTitle() || "").trim()
      if (title && title !== "about:blank") setDockTab(props.tab.id, { title })
    } catch {
      // Guest not ready yet.
    }
  }

  /** Hands the guest to the main-process agent bridge; safe to call repeatedly. */
  const registerGuest = () => {
    try {
      const guestID = guest?.getWebContentsId()
      if (guestID) void window.openorch.invoke("browser.register", props.tab.id, guestID).catch(() => undefined)
    } catch {
      // Guest not attached yet.
    }
  }

  const handlers: [string, (event: GuestEvent) => void][] = [
    ["did-start-loading", () => setLoading(true)],
    ["did-stop-loading", () => {
      setLoading(false)
      syncHistory()
      syncTitle()
      registerGuest()
      // Chromium updates its history entries right after the load settles.
      window.setTimeout(() => {
        syncHistory()
        syncTitle()
      }, 300)
    }],
    ["dom-ready", () => {
      syncHistory()
      syncTitle()
      registerGuest()
    }],
    [
      "did-navigate",
      (event) => {
        const url = event.url ?? ""
        // `about:blank` is our idle carrier, never a real page state.
        if (!url || url === "about:blank") return
        setAddress(url)
        setLastURL(url)
        setHasPage(true)
        setError("")
        setDockTab(props.tab.id, { url })
        syncHistory()
      },
    ],
    ["did-navigate-in-page", (event) => {
      if (event.isMainFrame && event.url && event.url !== "about:blank") setLastURL(event.url)
    }],
    [
      "page-title-updated",
      (event) => {
        const title = (event.title ?? "").trim()
        if (title) setDockTab(props.tab.id, { title })
        else syncTitle()
      },
    ],
    [
      "did-fail-load",
      (event) => {
        if (event.errorCode && event.errorCode !== -3) setError(t("browser.error"))
      },
    ],
  ]

  onMount(() => {
    if (!host) return
    const element = document.createElement("webview")
    element.className = "browser-webview"
    element.setAttribute("partition", props.tab.partition ?? "persist:openorch-web-session")
    element.setAttribute("allowpopups", "")
    element.setAttribute("src", props.tab.url ?? "about:blank")
    host.appendChild(element)
    guest = element as unknown as GuestView
    for (const [type, listener] of handlers) guest.addEventListener(type, listener)
    syncHistory()
  })

  onCleanup(() => {
    if (guest) for (const [type, listener] of handlers) guest.removeEventListener(type, listener)
    guest = undefined
    void window.openorch.invoke("browser.unregister", props.tab.id).catch(() => undefined)
  })

  const submit = () => {
    const target = normalizeAddress(address())
    if (!target) {
      if (address().trim()) setError(t("browser.invalid"))
      setAddress(lastURL())
      return
    }
    setError("")
    setAddress(target)
    setLastURL(target)
    if (!guest) return
    if (target === guest.getURL() && target !== "about:blank") {
      guest.reload()
      return
    }
    try {
      const result = guest.loadURL(target)
      if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => setError(t("browser.invalid")))
    } catch {
      setError(t("browser.invalid"))
    }
  }

  const openExternal = () => {
    const target = normalizeAddress(address()) ?? normalizeAddress(lastURL())
    if (target) void api.openExternal(target)
  }

  const goBack = () => {
    if (canBack()) guest?.goBack()
  }
  const goForward = () => {
    if (canForward()) guest?.goForward()
  }
  const reload = () => {
    if (!hasPage()) return
    if (loading()) guest?.stop()
    else guest?.reload()
  }

  return (
    <div class="browser-tab">
      <div class="browser-toolbar">
        <button class="icon-button" title={t("browser.back")} disabled={!canBack()} onClick={goBack}>
          <Icon name="arrow-left" size={14} />
        </button>
        <button class="icon-button" title={t("browser.forward")} disabled={!canForward()} onClick={goForward}>
          <Icon name="arrow-right" size={14} />
        </button>
        <button class="icon-button" title={t("browser.reload")} disabled={!hasPage()} onClick={reload}>
          ⟳
        </button>
        <input
          class="browser-address"
          type="text"
          spellcheck={false}
          placeholder={t("browser.address")}
          value={address()}
          onInput={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              submit()
            }
            if (event.key === "Escape") {
              event.stopPropagation()
              setAddress(lastURL())
            }
          }}
        />
        <button class="icon-button browser-external" title={t("browser.external")} disabled={!hasPage()} onClick={openExternal}>
          <Icon name="external" size={14} />
        </button>
      </div>
      <Show when={error()}>
        <div class="browser-error">⚠ {error()}</div>
      </Show>
      <div class="browser-body">
        {/* The guest lives in a childless container: Solid must never reconcile it away. */}
        <div class="browser-viewport" ref={host} />
        <Show when={!hasPage()}>
          <div class="browser-start">{t("browser.empty")}</div>
        </Show>
      </div>
    </div>
  )
}
