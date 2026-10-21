import type { BrowserService, BrowserSnapshot, BrowserTabInfo } from "@openorch/core"
import type { ExtensionBridge } from "./browser-bridge.js"

export type BrowserMode = "auto" | "embedded" | "extension"

function asTab(value: unknown): BrowserTabInfo {
  const result = value as { tab?: BrowserTabInfo } | undefined
  if (!result?.tab) throw new Error("[browser.extension] The extension returned no tab information.")
  return result.tab
}

/**
 * BrowserService backed by the Edge/Chrome extension.
 *
 * Every operation is a high-level RPC; the extension implements the CDP part.
 * Tab ids look like `edge:<numeric chrome tab id>`.
 */
export class ExtensionBrowser implements BrowserService {
  constructor(private bridge: ExtensionBridge) {}

  list(): BrowserTabInfo[] {
    return this.bridge.info.tabs
  }

  private call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeout?: number): Promise<T> {
    return this.bridge.call(op, args, timeout) as Promise<T>
  }

  private remember(tab: BrowserTabInfo): BrowserTabInfo {
    this.bridge.rememberTab(tab)
    return tab
  }

  async open(url?: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("open", url ? { url } : {})))
  }

  async close(tabID: string): Promise<BrowserTabInfo[]> {
    const result = await this.call<{ tabs?: BrowserTabInfo[] }>("close", { tabID })
    const tabs = Array.isArray(result?.tabs) ? result.tabs : []
    this.bridge.replaceTabs(tabs)
    return tabs
  }

  focus(tabID: string): BrowserTabInfo {
    const cached = this.list().find((tab) => tab.id === tabID)
    void this.call("focus", { tabID }).catch(() => undefined)
    return cached ?? { id: tabID, url: "", title: "" }
  }

  async navigate(tabID: string, url: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("navigate", { tabID, url })))
  }

  async back(tabID: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("back", { tabID })))
  }

  async forward(tabID: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("forward", { tabID })))
  }

  async reload(tabID: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("reload", { tabID })))
  }

  async snapshot(tabID: string, options?: { maxChars?: number }): Promise<BrowserSnapshot> {
    const result = await this.call<BrowserSnapshot>("snapshot", { tabID, maxChars: options?.maxChars })
    if (!result?.tab || typeof result.tree !== "string") {
      throw new Error("[browser.extension] The extension returned an invalid snapshot.")
    }
    this.bridge.rememberTab(result.tab)
    return result
  }

  async click(tabID: string, ref: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("click", { tabID, ref })))
  }

  async hover(tabID: string, ref: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("hover", { tabID, ref })))
  }

  async fill(tabID: string, ref: string, text: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("fill", { tabID, ref, text })))
  }

  async select(tabID: string, ref: string, values: string[]): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("select", { tabID, ref, values })))
  }

  async check(tabID: string, ref: string, checked: boolean): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("check", { tabID, ref, checked })))
  }

  async press(tabID: string, key: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("press", { tabID, key })))
  }

  async scroll(tabID: string, deltaY: number, ref?: string): Promise<BrowserTabInfo> {
    return this.remember(asTab(await this.call("scroll", { tabID, deltaY, ...(ref ? { ref } : {}) })))
  }

  async wait(tabID: string, options: { text?: string; timeoutMs: number }): Promise<{ tab: BrowserTabInfo; matched: boolean }> {
    const result = await this.call<{ tab: BrowserTabInfo; matched: boolean }>("wait", {
      tabID,
      text: options.text,
      timeoutMs: options.timeoutMs,
    })
    this.bridge.rememberTab(result.tab)
    return result
  }

  async screenshot(tabID: string): Promise<{ tab: BrowserTabInfo; dataUrl: string }> {
    const result = await this.call<{ tab: BrowserTabInfo; dataUrl: string }>("screenshot", { tabID })
    this.bridge.rememberTab(result.tab)
    return result
  }

  async evaluate(tabID: string, script: string): Promise<{ tab: BrowserTabInfo; value: unknown }> {
    const result = await this.call<{ tab: BrowserTabInfo; value: unknown }>("evaluate", { tabID, script }, 30_000)
    this.bridge.rememberTab(result.tab)
    return result
  }
}

/**
 * Chooses the active backend. `auto` prefers the extension whenever it is
 * connected; otherwise the integrated dock browser keeps working as before.
 */
export class BrowserRouter implements BrowserService {
  constructor(
    private embedded: BrowserService,
    private extension: ExtensionBrowser,
    private bridge: ExtensionBridge,
    private mode: () => BrowserMode,
  ) {}

  usesExtension(): boolean {
    const mode = this.mode()
    if (mode === "extension") return true
    if (mode === "embedded") return false
    return this.bridge.connected
  }

  private backend(): BrowserService {
    if (!this.usesExtension()) return this.embedded
    if (!this.bridge.connected) {
      throw new Error(
        "[browser.extension] The OpenOrch browser extension is not connected. Open Edge, click the OpenOrch Browser icon and connect it (Ajustes → Navegador), or switch to the integrated browser.",
      )
    }
    return this.extension
  }

  list(): BrowserTabInfo[] {
    return this.usesExtension() ? this.extension.list() : this.embedded.list()
  }

  async open(url?: string): Promise<BrowserTabInfo> {
    return this.backend().open(url)
  }

  async close(tabID: string): Promise<BrowserTabInfo[]> {
    return this.backend().close(tabID)
  }

  focus(tabID: string): BrowserTabInfo {
    return this.backend().focus(tabID)
  }

  async navigate(tabID: string, url: string): Promise<BrowserTabInfo> {
    return this.backend().navigate(tabID, url)
  }

  async back(tabID: string): Promise<BrowserTabInfo> {
    return this.backend().back(tabID)
  }

  async forward(tabID: string): Promise<BrowserTabInfo> {
    return this.backend().forward(tabID)
  }

  async reload(tabID: string): Promise<BrowserTabInfo> {
    return this.backend().reload(tabID)
  }

  async snapshot(tabID: string, options?: { maxChars?: number }): Promise<BrowserSnapshot> {
    return this.backend().snapshot(tabID, options)
  }

  async click(tabID: string, ref: string): Promise<BrowserTabInfo> {
    return this.backend().click(tabID, ref)
  }

  async hover(tabID: string, ref: string): Promise<BrowserTabInfo> {
    return this.backend().hover(tabID, ref)
  }

  async fill(tabID: string, ref: string, text: string): Promise<BrowserTabInfo> {
    return this.backend().fill(tabID, ref, text)
  }

  async select(tabID: string, ref: string, values: string[]): Promise<BrowserTabInfo> {
    return this.backend().select(tabID, ref, values)
  }

  async check(tabID: string, ref: string, checked: boolean): Promise<BrowserTabInfo> {
    return this.backend().check(tabID, ref, checked)
  }

  async press(tabID: string, key: string): Promise<BrowserTabInfo> {
    return this.backend().press(tabID, key)
  }

  async scroll(tabID: string, deltaY: number, ref?: string): Promise<BrowserTabInfo> {
    return this.backend().scroll(tabID, deltaY, ref)
  }

  async wait(tabID: string, options: { text?: string; timeoutMs: number }): Promise<{ tab: BrowserTabInfo; matched: boolean }> {
    return this.backend().wait(tabID, options)
  }

  async screenshot(tabID: string): Promise<{ tab: BrowserTabInfo; dataUrl: string }> {
    return this.backend().screenshot(tabID)
  }

  async evaluate(tabID: string, script: string): Promise<{ tab: BrowserTabInfo; value: unknown }> {
    return this.backend().evaluate(tabID, script)
  }
}
