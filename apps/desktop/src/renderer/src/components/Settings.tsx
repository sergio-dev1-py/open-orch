import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Config, McpServerConfig, ProviderInfo, SavedPermissionView, SkillInfo } from "@openorch/shared"
import { api } from "../api"
import { t } from "../i18n"
import { refreshConfig, refreshProviders, requestConfirm, setSettingsTab, state, toggleSettings, toggleSkillDialog } from "../store"
import { THEMES } from "../themes"
import { createModelCatalog, ModelOptions } from "./ModelCatalog"

type Tab = "general" | "providers" | "agents" | "permissions" | "mcp" | "browser" | "skills" | "about"

export function Settings() {
  // The active tab lives in the store so other views can deep-link into it.
  const tab = () => state.settingsTab
  const setTab = (value: Tab) => setSettingsTab(value)
  const config = () => state.config

  const patch = async (value: Partial<Config>) => {
    await api.setConfig(value)
    await refreshConfig()
  }

  // Escape closes the settings dialog.
  createEffect(() => {
    if (!state.settingsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        toggleSettings(false)
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  return (
    <Show when={state.settingsOpen}>
      <div class="modal-backdrop" onClick={() => toggleSettings(false)}>
        <div class="modal" onClick={(event) => event.stopPropagation()}>
          <button class="modal-close icon-button" title={t("app.close")} onClick={() => toggleSettings(false)}>
            ✕
          </button>
          <div class="modal-nav">
            <div style={{ padding: "4px 11px 12px", "font-weight": 650 }}>{t("settings.title")}</div>
            <For
              each={[
                ["general", t("settings.general")],
                ["providers", t("settings.providers")],
                ["agents", t("settings.agents")],
                ["permissions", t("settings.permissions")],
                ["mcp", t("settings.mcp")],
                ["browser", t("settings.browser")],
                ["skills", t("settings.skills")],
                ["about", t("settings.about")],
              ] as [Tab, string][]}
            >
              {([id, label]) => (
                <button class={tab() === id ? "active" : ""} onClick={() => setTab(id as Tab)}>
                  {label}
                </button>
              )}
            </For>
          </div>
          <div class="modal-body">
            <Show when={tab() === "general"}>
              <GeneralTab config={config()} onPatch={patch} />
            </Show>
            <Show when={tab() === "providers"}>
              <ProvidersTab />
            </Show>
            <Show when={tab() === "agents"}>
              <AgentsTab />
            </Show>
            <Show when={tab() === "permissions"}>
              <PermissionsTab />
            </Show>
            <Show when={tab() === "mcp"}>
              <McpTab onPatch={patch} config={config()} />
            </Show>
            <Show when={tab() === "browser"}>
              <BrowserTab config={config()} onPatch={patch} />
            </Show>
            <Show when={tab() === "skills"}>
              <SkillsTab onPatch={patch} config={config()} />
            </Show>
            <Show when={tab() === "about"}>
              <AboutTab />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

function GeneralTab(props: { config?: Config; onPatch: (value: Partial<Config>) => Promise<void> }) {
  return (
    <>
      <h2>{t("settings.general")}</h2>
      <div class="field">
        <label>{t("settings.language")}</label>
        <select value={props.config?.language ?? "es"} onChange={(event) => void props.onPatch({ language: event.currentTarget.value as "es" | "en" })}>
          <option value="es">Español</option>
          <option value="en">English</option>
        </select>
      </div>
      <div class="field">
        <label>{t("settings.theme")}</label>
        <select
          value={props.config?.theme ?? "light"}
          onChange={(event) => void props.onPatch({ theme: event.currentTarget.value as never })}
        >
          <For each={THEMES}>{(theme) => <option value={theme.id}>{t(theme.label)}</option>}</For>
          <option value="system">{t("settings.theme.system")}</option>
        </select>
      </div>
      <div class="field">
        <label>{t("settings.workingDirectory")}</label>
        <div class="row">
          <input type="text" value={props.config?.lastDirectory ?? ""} readOnly style={{ flex: 1 }} />
          <button
            class="button"
            onClick={async () => {
              const directory = await api.pickDirectory()
              if (directory) await props.onPatch({ lastDirectory: directory })
            }}
          >
            {t("settings.chooseFolder")}
          </button>
        </div>
        <span class="hint">Se usa como carpeta por defecto para nuevas sesiones.</span>
      </div>
      <div class="field">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={props.config?.compaction.auto ?? true}
            onChange={(event) => void props.onPatch({ compaction: { ...(props.config?.compaction ?? { auto: true, keep: 15000 }), auto: event.currentTarget.checked } })}
          />
          {t("settings.autocompact")}
        </label>
      </div>
      <div class="field">
        <label>{t("settings.keep")}</label>
        <input
          type="text"
          value={props.config?.compaction.keep ?? 15000}
          onChange={(event) => void props.onPatch({ compaction: { ...(props.config?.compaction ?? { auto: true, keep: 15000 }), keep: Number(event.currentTarget.value) || 15000 } })}
        />
      </div>
      <div class="field">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={props.config?.autoApprove ?? false}
            onChange={(event) => void props.onPatch({ autoApprove: event.currentTarget.checked })}
          />
          {t("settings.autoApprove")}
        </label>
      </div>
      <div class="field">
        <label>{t("settings.subagentDepth")}</label>
        <input
          type="text"
          value={props.config?.experimental?.subagentDepth ?? 1}
          onChange={(event) =>
            void props.onPatch({
              experimental: {
                ...(props.config?.experimental ?? { subagentDepth: 1, subagentVariant: "minimal" as const }),
                subagentDepth: Math.max(0, Number(event.currentTarget.value) || 1),
              },
            })
          }
        />
        <span class="hint">{t("settings.subagentDepth.hint")}</span>
      </div>
      <div class="field">
        <label>{t("settings.subagentVariant")}</label>
        <select
          value={props.config?.experimental?.subagentVariant ?? "minimal"}
          onChange={(event) =>
            void props.onPatch({
              experimental: {
                ...(props.config?.experimental ?? { subagentDepth: 1, subagentVariant: "minimal" }),
                subagentVariant: event.currentTarget.value as "minimal" | "inherit",
              },
            })
          }
        >
          <option value="minimal">{t("settings.subagentVariant.minimal")}</option>
          <option value="inherit">{t("settings.subagentVariant.inherit")}</option>
        </select>
        <span class="hint">{t("settings.subagentVariant.hint")}</span>
      </div>
      <h2 style={{ "margin-top": "22px" }}>{t("settings.websearch")}</h2>
      <div class="field">
        <label>{t("settings.websearch.provider")}</label>
        <select
          value={props.config?.websearch.provider ?? ""}
          onChange={(event) => void props.onPatch({ websearch: { ...(props.config?.websearch ?? {}), provider: (event.currentTarget.value || undefined) as never } })}
        >
          <option value="">—</option>
          <option value="duckduckgo">DuckDuckGo → Bing → TinyFish (sin clave)</option>
          <option value="tinyfish">TinyFish (clave opcional)</option>
          <option value="parallel">Parallel (clave opcional)</option>
          <option value="exa">Exa</option>
          <option value="brave">Brave</option>
          <option value="tavily">Tavily</option>
        </select>
        <span class="hint">{t("settings.websearch.hint")}</span>
      </div>
      <div class="field">
        <label>{t("settings.websearch.key")}</label>
        <input
          type="password"
          value={props.config?.websearch.apiKey ?? ""}
          onChange={(event) => void props.onPatch({ websearch: { ...(props.config?.websearch ?? {}), apiKey: event.currentTarget.value || undefined } })}
        />
      </div>
    </>
  )
}

function BrowserTab(props: { config?: Config; onPatch: (value: Partial<Config>) => Promise<void> }) {
  type Info = Awaited<ReturnType<typeof api.browserExtension.info>>
  const [info, setInfo] = createSignal<Info | undefined>()
  const [copied, setCopied] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const load = async () => {
    try {
      setInfo(await api.browserExtension.info())
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  onMount(() => {
    void load()
    const timer = window.setInterval(() => void load(), 2_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const mode = () => props.config?.browser?.mode ?? "auto"
  const setMode = (value: "auto" | "embedded" | "extension") =>
    void props.onPatch({ browser: { ...(props.config?.browser ?? { mode: "auto" }), mode: value } })

  const copyToken = async () => {
    const token = info()?.token
    if (!token) return
    await window.openorch.clipboard.writeText(token)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await run()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const connected = () => Boolean(info()?.connected)
  const statusColor = () => (connected() ? "var(--success)" : info()?.lastError ? "var(--warning)" : "var(--text-faint)")

  return (
    <>
      <h2>{t("settings.browser")}</h2>
      <div class="field">
        <label>{t("settings.browser.mode")}</label>
        <select value={mode()} onChange={(event) => setMode(event.currentTarget.value as never)}>
          <option value="auto">{t("settings.browser.auto")}</option>
          <option value="embedded">{t("settings.browser.embedded")}</option>
          <option value="extension">{t("settings.browser.extension")}</option>
        </select>
        <span class="hint">{t("settings.browser.autoHint")}</span>
      </div>

      <div class="field">
        <label>{t("settings.browser.status")}</label>
        <div style={{ display: "flex", "align-items": "center", gap: "9px", padding: "9px 11px", border: "1px solid var(--border)", "border-radius": "8px" }}>
          <span style={{ width: "9px", height: "9px", "border-radius": "999px", background: statusColor(), flex: "none" }} />
          <div style={{ "min-width": 0, flex: 1 }}>
            <div style={{ "font-weight": 600 }}>
              {connected()
                ? `${t("settings.browser.connected")}${info()?.version ? ` · v${info()?.version}` : ""}`
                : info()?.lastError
                  ? `${t("settings.browser.disconnected")} · ${info()?.lastError}`
                  : t("settings.browser.disconnected")}
            </div>
            <div class="hint" style={{ margin: 0 }}>
              {info()?.version ? `v${info()?.version} · ` : ""}
              {t("settings.browser.server")}: ws://127.0.0.1:{info()?.port || "—"}
            </div>
          </div>
          <button class="button" disabled={busy()} onClick={() => void act(() => api.browserExtension.disconnect())}>
            {t("settings.browser.disconnect")}
          </button>
        </div>
      </div>

      <div class="field">
        <label>{t("settings.browser.code")}</label>
        <div class="row">
          <input type="text" readOnly value={info()?.token ?? ""} style={{ flex: 1, "font-family": "ui-monospace, monospace" }} />
          <button class="button" onClick={() => void copyToken()}>
            {copied() ? t("settings.browser.copied") : t("settings.browser.copy")}
          </button>
          <button class="button" disabled={busy()} onClick={() => void act(() => api.browserExtension.reset())}>
            {t("settings.browser.reset")}
          </button>
        </div>
        <span class="hint">{t("settings.browser.help")}</span>
        <span class="hint" style={{ display: "block" }}>{t("settings.browser.tokenHint")}</span>
      </div>

      <div class="field">
        <label>{t("settings.browser.folder")}</label>
        <div class="row">
          <input type="text" readOnly value={info()?.extensionPath ?? ""} style={{ flex: 1 }} />
          <button class="button" onClick={() => void act(() => api.browserExtension.openFolder())}>
            {t("settings.browser.openFolder")}
          </button>
        </div>
      </div>

      <div class="field">
        <label>{t("settings.browser.tabs")}</label>
        {info()?.tabs.length ? (
          <div class="dock-rows" style={{ "max-height": "150px", overflow: "auto" }}>
            <For each={info()?.tabs ?? []}>
              {(tab) => (
                <div style={{ "font-size": "12px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {tab.title || "(sin título)"} — <span style={{ color: "var(--text-faint)" }}>{tab.url}</span>
                </div>
              )}
            </For>
          </div>
        ) : (
          <span class="hint">{t("settings.browser.noTabs")}</span>
        )}
      </div>

      <Show when={error()}>
        <div class="hint" style={{ color: "var(--error)" }}>{error()}</div>
      </Show>
    </>
  )
}

function ProvidersTab() {
  const modelCatalog = createModelCatalog()
  const [refreshing, setRefreshing] = createSignal<string | undefined>()
  const [refreshInfo, setRefreshInfo] = createSignal<string | undefined>()
  const [catalog, setCatalog] = createSignal<{ source: string; updatedAt?: number; account?: { active: number; updatedAt: number } }>()
  const [catalogBusy, setCatalogBusy] = createSignal(false)
  const [catalogInfo, setCatalogInfo] = createSignal<string | undefined>()

  const loadCatalog = () => {
    void api
      .catalogStatus()
      .then(setCatalog)
      .catch(() => undefined)
  }
  loadCatalog()

  const relativeCatalogTime = (timestamp: number) => {
    const minutes = Math.floor((Date.now() - timestamp) / 60000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  const refreshCatalog = async () => {
    setCatalogBusy(true)
    setCatalogInfo(undefined)
    const result = await api.refreshModelsCatalog()
    setCatalogBusy(false)
    setCatalogInfo(
      result.ok
        ? `${t("settings.catalog.done")} · ${result.models} ${t("settings.catalog.models")}`
        : `${t("settings.catalog.failed")}: ${result.error ?? "error"}`,
    )
    loadCatalog()
    if (result.ok) await refreshProviders()
  }

  const connectedProviders = createMemo(() => state.providers.filter((provider) => provider.configured))
  const maskedKey = (providerID: string): string => {
    const key = state.config?.providers[providerID]?.apiKey
    if (!key) return ""
    if (key.length <= 8) return "••••"
    return `${key.slice(0, 4)}…${key.slice(-4)}`
  }
  const autoSmallModel = createMemo(() => {
    const families = ["gpt-luna", "gemini-flash-lite", "gemini-flash", "claude-haiku"]
    const models = state.models
    for (const family of families) {
      const found = models.find((model) => model.family === family)
      if (found) return `${found.providerID}/${found.id}`
    }
    const smallish = /flash-lite|flash|haiku|mini|nano|small/i
    const fallback = models.find((model) => smallish.test(`${model.family ?? ""} ${model.id}`) && model.toolCall)
    return fallback ? `${fallback.providerID}/${fallback.id}` : undefined
  })
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal<string | undefined>()
  const [draft, setDraft] = createSignal<Record<string, { apiKey: string; baseURL: string }>>({})
  const [testResult, setTestResult] = createSignal<Record<string, { ok: boolean; error?: string; testing?: boolean }>>({})
  const [adding, setAdding] = createSignal(false)
  const [newProvider, setNewProvider] = createSignal({ id: "", name: "", baseURL: "", apiKey: "", models: "" })

  const providers = createMemo(() => {
    const search = query().toLowerCase()
    return state.providers.filter(
      (provider) =>
        provider.configured ||
        provider.id.toLowerCase().includes(search) ||
        provider.name.toLowerCase().includes(search),
    )
  })

  const draftFor = (provider: ProviderInfo) => {
    const existing = draft()[provider.id]
    if (existing) return existing
    const settings = state.config?.providers[provider.id]
    return { apiKey: settings?.apiKey ?? "", baseURL: settings?.baseURL ?? "" }
  }

  const save = async (provider: ProviderInfo) => {
    const value = draftFor(provider)
    const settings = { ...(state.config?.providers[provider.id] ?? {}) }
    settings.apiKey = value.apiKey || undefined
    settings.baseURL = value.baseURL || undefined
    settings.enabled = true
    await api.setConfig({ providers: { [provider.id]: settings } as never })
    await refreshProviders()
    await refreshConfig()
  }

  const test = async (provider: ProviderInfo) => {
    setTestResult({ ...testResult(), [provider.id]: { ok: false, testing: true } })
    const value = draftFor(provider)
    const result = await api.testProvider(provider.id, { apiKey: value.apiKey, baseURL: value.baseURL })
    setTestResult({ ...testResult(), [provider.id]: result })
  }

  const addProvider = async () => {
    const value = newProvider()
    const id = value.id.trim()
    if (!id || !value.baseURL.trim()) return
    await api.setConfig({
      providers: {
        [id]: {
          kind: "openai-compatible",
          name: value.name || id,
          baseURL: value.baseURL.trim(),
          apiKey: value.apiKey || undefined,
          models: value.models
            .split(",")
            .map((model) => model.trim())
            .filter(Boolean),
          enabled: true,
        },
      } as never,
    })
    setAdding(false)
    setNewProvider({ id: "", name: "", baseURL: "", apiKey: "", models: "" })
    await refreshProviders()
  }

  const defaultModel = () => {
    const ref = state.config?.model
    return ref ? `${ref.providerID}/${ref.modelID}` : ""
  }

  return (
    <>
      <h2>{t("settings.providers")}</h2>
      <div class="field">
        <label>{t("settings.defaultModel")}</label>
        <select
          value={defaultModel()}
          onChange={(event) => {
            const [providerID, modelID] = event.currentTarget.value.split("/")
            void api.setConfig({ model: providerID && modelID ? { providerID, modelID } : undefined }).then(refreshConfig)
          }}
        >
          <option value="">{t("settings.model.auto")}</option>
          <Show when={defaultModel() && !modelCatalog.models().some((model) => `${model.providerID}/${model.id}` === defaultModel())}>
            <option value={defaultModel()}>{defaultModel()}</option>
          </Show>
          <ModelOptions models={modelCatalog.models()} />
        </select>
      </div>
      <div class="field">
        <label>{t("settings.smallModel")}</label>
        <select
          value={state.config?.smallModel ? `${state.config.smallModel.providerID}/${state.config.smallModel.modelID}` : ""}
          onChange={(event) => {
            const [providerID, modelID] = event.currentTarget.value.split("/")
            void api.setConfig({ smallModel: providerID && modelID ? { providerID, modelID } : undefined }).then(refreshConfig)
          }}
        >
          <option value="">{t("settings.model.auto")}</option>
          <Show
            when={
              state.config?.smallModel &&
              !modelCatalog
                .models()
                .some((model) => model.providerID === state.config?.smallModel?.providerID && model.id === state.config?.smallModel?.modelID)
            }
          >
            <option value={`${state.config?.smallModel?.providerID}/${state.config?.smallModel?.modelID}`}>
              {state.config?.smallModel?.providerID} / {state.config?.smallModel?.modelID}
            </option>
          </Show>
          <ModelOptions models={modelCatalog.models()} />
        </select>
        <span class="hint">
          {state.config?.smallModel
            ? t("settings.smallModel.hint.manual")
            : `${t("settings.smallModel.hint.auto")}: ${autoSmallModel() ?? "—"}`}
        </span>
      </div>
      <div class="field">
        <label>{t("settings.subagentModel")}</label>
        <select
          value={
            state.config?.experimental?.subagentModel
              ? `${state.config.experimental.subagentModel.providerID}/${state.config.experimental.subagentModel.modelID}`
              : ""
          }
          onChange={(event) => {
            const [providerID, modelID] = event.currentTarget.value.split("/")
            const experimental = state.config?.experimental ?? { subagentDepth: 1, subagentVariant: "minimal" as const }
            void api
              .setConfig({
                experimental: {
                  ...experimental,
                  subagentModel: providerID && modelID ? { providerID, modelID } : null,
                },
              })
              .then(refreshConfig)
          }}
        >
          <option value="">{t("settings.subagentModel.same")}</option>
          <Show
            when={
              state.config?.experimental?.subagentModel &&
              !modelCatalog
                .models()
                .some(
                  (model) =>
                    model.providerID === state.config?.experimental?.subagentModel?.providerID &&
                    model.id === state.config?.experimental?.subagentModel?.modelID,
                )
            }
          >
            <option
              value={`${state.config?.experimental?.subagentModel?.providerID}/${state.config?.experimental?.subagentModel?.modelID}`}
            >
              {state.config?.experimental?.subagentModel?.providerID} / {state.config?.experimental?.subagentModel?.modelID}
            </option>
          </Show>
          <ModelOptions models={modelCatalog.models()} />
        </select>
        <span class="hint">{t("settings.subagentModel.hint")}</span>
      </div>
      <Show when={modelCatalog.models().length === 0}>
        <div class="field">
          <span class="hint">
            {modelCatalog.loading() ? t("settings.modelsLoading") : modelCatalog.error() || t("settings.modelsEmpty")}
          </span>
          <button class="button" onClick={() => void modelCatalog.refresh()}>
            {t("settings.refreshModels")}
          </button>
        </div>
      </Show>

      {/* Live models.dev catalog: new API models and their real reasoning levels. */}
      <h2 style={{ "margin-top": "20px" }}>{t("settings.catalog.title")}</h2>
      <div class="provider-row">
        <span class="dot" style={{ background: catalog()?.updatedAt ? "var(--accent)" : "var(--text-faint)" }} />
        <span class="name">
          {catalog()?.source === "live"
            ? t("settings.catalog.live")
            : catalog()?.source === "cache"
              ? t("settings.catalog.cache")
              : t("settings.catalog.embedded")}
        </span>
        <span class="meta">
          {catalog()?.updatedAt ? `${t("settings.catalog.updated")} ${relativeCatalogTime(catalog()!.updatedAt!)}` : t("settings.catalog.never")}
          {catalog()?.account ? ` · ${t("settings.catalog.account")}: ${catalog()!.account!.active}` : ""}
        </span>
        <span class="spacer" />
        <button class="button" disabled={catalogBusy()} onClick={() => void refreshCatalog()}>
          {catalogBusy() ? t("app.testing") : t("settings.catalog.refresh")}
        </button>
      </div>
      <Show when={catalogInfo()}>
        <div class="hint refresh-info" style={{ color: "var(--text-faint)", "font-size": "12px", "margin-bottom": "8px" }}>
          {catalogInfo()}
        </div>
      </Show>

      {/* Connected providers: quick view with a disconnect action. */}
      <h2 style={{ "margin-top": "20px" }}>{t("settings.connected")}</h2>
      <Show
        when={connectedProviders().length > 0}
        fallback={<div class="hint" style={{ color: "var(--text-faint)", "font-size": "12.5px" }}>{t("settings.connected.none")}</div>}
      >
        <For each={connectedProviders()}>
          {(provider) => (
            <div class="provider-row connected">
              <span class="dot" style={{ background: "var(--success)" }} />
              <span class="name">{provider.name}</span>
              <span class="meta">
                {provider.id} · {provider.models.length} modelos
                {maskedKey(provider.id) ? ` · ${maskedKey(provider.id)}` : ""}
              </span>
              <span class="spacer" />
              <button
                class="button"
                onClick={async () => {
                  setRefreshing(provider.id)
                  const result = await api.refreshProviderModels(provider.id)
                  setRefreshing(undefined)
                  setRefreshInfo(
                    `${provider.id}: ${result.ok ? `+${result.added} modelos (${result.total} en la API)` : result.error ?? "error"}`,
                  )
                  await refreshProviders()
                }}
                disabled={refreshing() === provider.id}
              >
                {refreshing() === provider.id ? t("app.testing") : t("settings.refreshModels")}
              </button>
              <button
                class="button danger"
                onClick={() =>
                  requestConfirm({
                    title: t("settings.disconnect.title"),
                    message: t("settings.disconnect.message", { provider: provider.name }),
                    confirmLabel: t("settings.disconnect"),
                    danger: true,
                    onConfirm: async () => {
                      await api.disconnectProvider(provider.id)
                      await refreshProviders()
                      await refreshConfig()
                    },
                  })
                }
              >
                {t("settings.disconnect")}
              </button>
            </div>
          )}
        </For>
      </Show>
      <Show when={refreshInfo()}>
        <div class="hint refresh-info" style={{ color: "var(--text-faint)", "font-size": "12px", "margin-bottom": "8px" }}>
          {refreshInfo()}
        </div>
      </Show>

      <div class="row" style={{ "margin-top": "18px", "margin-bottom": "10px" }}>
        <input
          type="text"
          placeholder="Buscar proveedor…"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <button class="button" onClick={() => setAdding(!adding())}>
          {t("settings.provider.add")}
        </button>
      </div>

      <Show when={adding()}>
        <div style={{ border: "1px solid var(--border)", "border-radius": "8px", padding: "12px", "margin-bottom": "12px" }}>
          <div class="field">
            <label>{t("settings.provider.id")}</label>
            <input type="text" value={newProvider().id} onInput={(event) => setNewProvider({ ...newProvider(), id: event.currentTarget.value })} />
          </div>
          <div class="field">
            <label>{t("settings.provider.name")}</label>
            <input type="text" value={newProvider().name} onInput={(event) => setNewProvider({ ...newProvider(), name: event.currentTarget.value })} />
          </div>
          <div class="field">
            <label>{t("settings.provider.baseURL")}</label>
            <input type="text" placeholder="https://api.example.com/v1" value={newProvider().baseURL} onInput={(event) => setNewProvider({ ...newProvider(), baseURL: event.currentTarget.value })} />
          </div>
          <div class="field">
            <label>{t("settings.provider.apiKey")}</label>
            <input type="password" value={newProvider().apiKey} onInput={(event) => setNewProvider({ ...newProvider(), apiKey: event.currentTarget.value })} />
          </div>
          <div class="field">
            <label>{t("settings.provider.models")}</label>
            <input type="text" placeholder="model-a, model-b" value={newProvider().models} onInput={(event) => setNewProvider({ ...newProvider(), models: event.currentTarget.value })} />
          </div>
          <button class="button primary" onClick={() => void addProvider()}>
            {t("app.save")}
          </button>
        </div>
      </Show>

      <For each={providers()}>
        {(provider) => (
          <div style={{ "margin-bottom": "6px" }}>
            <div class="provider-row" onClick={() => setExpanded(expanded() === provider.id ? undefined : provider.id)} style={{ cursor: "pointer" }}>
              <span class="name">{provider.name}</span>
              <span class="meta">{provider.id} · {provider.models.length} modelos</span>
              <span class="spacer" />
              <Show when={provider.env?.length}>
                <span class="meta">{t("settings.provider.env")} {provider.env?.join(", ")}</span>
              </Show>
              <Show when={provider.configured} fallback={<span class="badge">—</span>}>
                <span class="badge ok">{t("settings.provider.configured")}</span>
              </Show>
            </div>
            <Show when={expanded() === provider.id}>
              <div style={{ border: "1px solid var(--border)", "border-top": "none", "border-radius": "0 0 8px 8px", padding: "10px 12px" }}>
                <div class="field">
                  <label>{t("settings.provider.apiKey")}</label>
                  <input
                    type="password"
                    value={draftFor(provider).apiKey}
                    onInput={(event) => setDraft({ ...draft(), [provider.id]: { ...draftFor(provider), apiKey: event.currentTarget.value } })}
                  />
                </div>
                <div class="field">
                  <label>{t("settings.provider.baseURL")}</label>
                  <input
                    type="text"
                    value={draftFor(provider).baseURL}
                    placeholder={provider.baseURL ?? ""}
                    onInput={(event) => setDraft({ ...draft(), [provider.id]: { ...draftFor(provider), baseURL: event.currentTarget.value } })}
                  />
                </div>
                <div class="row">
                  <button class="button primary" onClick={() => void save(provider)}>
                    {t("app.save")}
                  </button>
                  <button class="button" disabled={testResult()[provider.id]?.testing} onClick={() => void test(provider)}>
                    {testResult()[provider.id]?.testing ? t("app.testing") : t("app.test")}
                  </button>
                  <Show when={testResult()[provider.id] && !testResult()[provider.id]?.testing}>
                    <Show
                      when={testResult()[provider.id]?.ok}
                      fallback={<span class="badge err">{t("app.failed")}: {testResult()[provider.id]?.error}</span>}
                    >
                      <span class="badge ok">{t("app.ok")}</span>
                    </Show>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        )}
      </For>
    </>
  )
}

function AgentsTab() {
  return (
    <>
      <h2>{t("settings.agents")}</h2>
      <div class="hint" style={{ "margin-bottom": "12px", color: "var(--text-faint)", "font-size": "12.5px" }}>
        Los agentes se definen en <code>.opencode/agent/*.md</code> (proyecto) o <code>~/.config/opencode/agent/*.md</code> (global) con frontmatter YAML
        (<code>model, mode, hidden, steps, permissions…</code>). Los archivos markdown se usan también como system prompt.
      </div>
      <For each={state.agents}>
        {(agent) => (
          <div class="provider-row">
            <span class="name">{agent.name}</span>
            <span class="meta">{agent.id} · {agent.mode}{agent.hidden ? " · hidden" : ""}{agent.source === "custom" ? " · custom" : ""}</span>
            <span class="spacer" />
            <Show when={agent.model}>
              <span class="badge">{agent.model?.providerID}/{agent.model?.modelID}</span>
            </Show>
          </div>
        )}
      </For>
    </>
  )
}

function PermissionsTab() {
  const [saved, setSaved] = createSignal<SavedPermissionView[]>([])
  void api.savedPermissions().then(setSaved)
  return (
    <>
      <h2>{t("settings.permissions")}</h2>
      <div class="hint" style={{ color: "var(--text-faint)", "font-size": "12.5px", "margin-bottom": "12px" }}>
        Cada agente aplica reglas allow/deny/ask con comodines. Las reglas "Allow always" que aceptes se guardan aquí (por carpeta de proyecto).
      </div>
      <Show when={saved().length === 0}>
        <div class="hint" style={{ color: "var(--text-faint)", "font-size": "12.5px" }}>{t("settings.permissions.none")}</div>
      </Show>
      <For each={saved()}>
        {(rule) => (
          <div class="saved-rule">
            <span style={{ color: "var(--success)" }}>allow</span>
            <span>{rule.action}</span>
            <span style={{ color: "var(--text-faint)" }}>{rule.resource}</span>
            <Show when={rule.project}>
              <span style={{ "margin-left": "auto", color: "var(--text-faint)", "font-size": "11px" }}>
                {rule.project.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}
              </span>
            </Show>
          </div>
        )}
      </For>
      <Show when={saved().length > 0}>
        <button
          class="button danger"
          style={{ "margin-top": "12px" }}
          onClick={() =>
            requestConfirm({
              title: t("app.confirm.clearPermissions.title"),
              message: t("app.confirm.clearPermissions.message"),
              confirmLabel: t("app.delete"),
              danger: true,
              onConfirm: async () => {
                await api.clearSavedPermissions()
                setSaved([])
              },
            })
          }
        >
          {t("settings.permissions.clear")}
        </button>
      </Show>
    </>
  )
}

function McpTab(props: { config?: Config; onPatch: (value: Partial<Config>) => Promise<void> }) {
  const [name, setName] = createSignal("")
  const [type, setType] = createSignal<"local" | "remote">("local")
  const [command, setCommand] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [environment, setEnvironment] = createSignal("")
  const [timeout, setTimeout] = createSignal("")
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [busy, setBusy] = createSignal("")

  const parseEnvironment = (): Record<string, string> | undefined => {
    const entries = environment()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=")
        return (index === -1 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]) as [string, string]
      })
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  const add = async () => {
    const key = name().trim()
    if (!key) return
    const timeoutValue = Number(timeout())
    const common = { enabled: true, ...(Number.isFinite(timeoutValue) && timeoutValue > 0 ? { timeout: timeoutValue } : {}) }
    const server =
      type() === "local"
        ? {
            type: "local" as const,
            command: command().trim().split(/\s+/),
            ...(parseEnvironment() ? { environment: parseEnvironment() } : {}),
            ...common,
          }
        : {
            type: "remote" as const,
            url: url().trim(),
            ...(clientId().trim()
              ? { oauth: { clientId: clientId().trim(), ...(clientSecret().trim() ? { clientSecret: clientSecret().trim() } : {}) } }
              : {}),
            ...common,
          }
    await props.onPatch({ mcp: { ...(props.config?.mcp ?? {}), [key]: server } })
    setName("")
    setCommand("")
    setUrl("")
    setEnvironment("")
    setTimeout("")
    setClientId("")
    setClientSecret("")
  }

  const remove = async (key: string) => {
    const next = { ...(props.config?.mcp ?? {}) }
    delete next[key]
    await props.onPatch({ mcp: next })
  }

  const toggle = async (key: string) => {
    const server = props.config?.mcp[key]
    if (!server) return
    await props.onPatch({ mcp: { ...props.config?.mcp, [key]: { ...server, enabled: !(server.enabled ?? true) } } })
  }

  const authenticate = async (key: string) => {
    setBusy(key)
    try {
      await api.mcpAuthenticate(key)
    } finally {
      setBusy("")
    }
  }

  const logout = async (key: string) => {
    setBusy(key)
    try {
      await api.mcpLogout(key)
    } finally {
      setBusy("")
    }
  }

  /** Global entries (config.json) plus project entries (`.openorch/mcp.json`). */
  const mcpRows = createMemo(() => {
    const configured = new Set(Object.keys(props.config?.mcp ?? {}))
    const global = Object.entries(props.config?.mcp ?? {}).map(([key, server]) => ({
      key,
      server: server as McpServerConfig | undefined,
      scope: "global" as const,
      status: state.mcp.find((entry) => entry.name === key),
    }))
    const project = state.mcp
      .filter((entry) => entry.scope === "project" && !configured.has(entry.name))
      .map((entry) => ({ key: entry.name, server: undefined, scope: "project" as const, status: entry }))
    return [...global, ...project]
  })

  return (
    <>
      <h2>{t("settings.mcp")}</h2>
      <p class="hint" style={{ "margin-top": "-8px", "margin-bottom": "12px" }}>
        {t("settings.mcp.projectHint")}
      </p>
      <For each={mcpRows()}>
        {(row) => {
          const status = row.status
          return (
            <div>
              <div class="provider-row">
                <span class="name">{row.key}</span>
                <Show when={row.scope === "project"}>
                  <span class="badge">{t("settings.mcp.project")}</span>
                </Show>
                <span class="meta">
                  {row.server
                    ? row.server.type === "local"
                      ? row.server.command?.join(" ")
                      : row.server.url
                    : (status?.target ?? "")}
                </span>
                <span class="spacer" />
                <Show when={status}>
                  <span
                    class={`badge ${status?.status === "connected" ? "ok" : status?.status === "needs-auth" ? "warn" : "err"}`}
                  >
                    {status?.status === "connected"
                      ? `connected · ${status?.tools} tools`
                      : status?.status === "needs-auth"
                        ? t("settings.mcp.needsAuth")
                        : (status?.error ?? "error")}
                  </span>
                </Show>
                <Show when={status?.status === "needs-auth"}>
                  <button class="button primary" disabled={busy() === row.key} onClick={() => void authenticate(row.key)}>
                    {t("settings.mcp.signIn")}
                  </button>
                </Show>
                <Show when={status?.status === "connected" && (row.server?.type === "remote" || status?.target?.startsWith("http"))}>
                  <button class="button" disabled={busy() === row.key} onClick={() => void logout(row.key)}>
                    {t("settings.mcp.signOut")}
                  </button>
                </Show>
                <Show when={row.scope === "global"}>
                  <button class="button" onClick={() => void toggle(row.key)}>
                    {(row.server?.enabled ?? true) ? "Disable" : "Enable"}
                  </button>
                  <button class="button danger" onClick={() => void remove(row.key)}>
                    ✕
                  </button>
                </Show>
              </div>
              <Show when={(status?.toolNames?.length ?? 0) > 0}>
                <details class="mcp-tools">
                  <summary>{status?.tools} tools</summary>
                  <div class="mcp-tools-list">{status?.toolNames?.join(", ")}</div>
                </details>
              </Show>
            </div>
          )
        }}
      </For>
      <div style={{ border: "1px solid var(--border)", "border-radius": "8px", padding: "12px", "margin-top": "12px" }}>
        <div class="field">
          <label>Nombre</label>
          <input type="text" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </div>
        <div class="field">
          <label>Tipo</label>
          <select value={type()} onChange={(event) => setType(event.currentTarget.value as "local" | "remote")}>
            <option value="local">{t("settings.mcp.local")}</option>
            <option value="remote">{t("settings.mcp.remote")}</option>
          </select>
        </div>
        <Show when={type() === "local"} fallback={
          <>
            <div class="field">
              <label>{t("settings.mcp.url")}</label>
              <input type="text" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
            </div>
            <div class="field">
              <label>{t("settings.mcp.oauthClient")}</label>
              <input type="text" placeholder="client_id" value={clientId()} onInput={(event) => setClientId(event.currentTarget.value)} />
            </div>
            <Show when={clientId().trim().length > 0}>
              <div class="field">
                <label>{t("settings.mcp.oauthSecret")}</label>
                <input type="password" value={clientSecret()} onInput={(event) => setClientSecret(event.currentTarget.value)} />
              </div>
            </Show>
          </>
        }>
          <div class="field">
            <label>{t("settings.mcp.command")}</label>
            <input type="text" placeholder="npx -y @modelcontextprotocol/server-filesystem ." value={command()} onInput={(event) => setCommand(event.currentTarget.value)} />
          </div>
          <div class="field">
            <label>{t("settings.mcp.environment")}</label>
            <textarea rows={2} placeholder="MY_VAR=value" value={environment()} onInput={(event) => setEnvironment(event.currentTarget.value)} />
          </div>
        </Show>
        <div class="field">
          <label>{t("settings.mcp.timeout")}</label>
          <input type="number" min="0" placeholder="30000" value={timeout()} onInput={(event) => setTimeout(event.currentTarget.value)} />
        </div>
        <button class="button primary" onClick={() => void add()}>
          {t("settings.mcp.add")}
        </button>
      </div>
    </>
  )
}

function SkillsTab(props: { config?: Config; onPatch: (value: Partial<Config>) => Promise<void> }) {
  const [draft, setDraft] = createSignal((props.config?.skills.dirs ?? []).join("\n"))
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const refresh = () => {
    void api
      .listSkills(state.activeSessionID ?? "")
      .then(setSkills)
      .catch(() => setSkills([]))
  }
  refresh()
  createEffect(() => {
    void state.skillsRevision
    refresh()
  })
  return (
    <>
      <h2>{t("settings.skills")}</h2>
      <div class="hint" style={{ color: "var(--text-faint)", "font-size": "12.5px", "margin-bottom": "10px" }}>
        {t("settings.skills.hint")}
      </div>
      <div class="field">
        <label>{t("skills.installed")}</label>
        <Show when={skills().length > 0} fallback={<span class="hint">{t("skills.none")}</span>}>
          <div class="skill-list">
            <For each={skills()}>
              {(skill) => (
                <div class="skill-row">
                  <span class="skill-id">{skill.id}</span>
                  <span class="skill-origin">
                    {skill.origin === "project" ? t("skills.origin.project") : skill.origin === "custom" ? t("skills.origin.custom") : t("skills.origin.global")}
                  </span>
                  <span class="skill-description">{skill.description}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <button class="button primary" style={{ "margin-bottom": "16px" }} onClick={() => toggleSkillDialog(true)}>
        {t("skills.add")}
      </button>
      <div class="field">
        <label>{t("settings.skills.dirs")}</label>
        <textarea rows={4} value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} />
      </div>
      <button class="button primary" onClick={() => void props.onPatch({ skills: { dirs: draft().split("\n").map((line) => line.trim()).filter(Boolean) } })}>
        {t("app.save")}
      </button>
    </>
  )
}

function AboutTab() {
  const [version, setVersion] = createSignal("")
  void api.appVersion().then(setVersion)
  return (
    <>
      <h2>{t("settings.about")}</h2>
      <div style={{ "font-size": "13px", color: "var(--text-muted)", "line-height": 1.7 }}>
        <div><strong>OpenOrch</strong> {version()} — un agente de código inspirado en OpenCode.</div>
        <div>Los prompts de sistema y definiciones de agentes incorporados se copian de OpenCode (MIT).</div>
        <div style={{ "margin-top": "10px" }}>
          Electron {window.openorch.versions.electron} · Chromium {window.openorch.versions.chrome} · Node {window.openorch.versions.node}
        </div>
      </div>
    </>
  )
}
