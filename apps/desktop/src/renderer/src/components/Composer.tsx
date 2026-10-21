import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { AgentInfo, FileAttachment, ModelInfo, ProviderInfo } from "@openorch/shared"
import { api } from "../api"
import { t, variantLabel } from "../i18n"
import { Icon } from "./Icons"
import {
  activeBusy,
  activeSession,
  primaryAgents,
  refreshModelPrefs,
  sendPrompt,
  setAgent,
  setModel,
  state,
  interrupt,
  runCommand,
  toggleSkillDialog,
} from "../store"

interface Suggestion {
  kind: "file" | "command" | "skill" | "agent"
  value: string
  label: string
  description?: string
}

const COMMANDS: Suggestion[] = [
  { kind: "command", value: "/compact", label: "/compact", description: "Compactar contexto" },
  { kind: "command", value: "/new", label: "/new", description: "Nueva sesión" },
  { kind: "command", value: "/settings", label: "/settings", description: "Abrir ajustes" },
  { kind: "command", value: "/skill", label: "/skill", description: "Instalar o gestionar skills globales" },
  { kind: "command", value: "/plan", label: "/plan", description: "Cambiar a Plan (solo lectura)" },
  { kind: "command", value: "/build", label: "/build", description: "Cambiar a Build" },
]

function ProviderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  )
}

function AgentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M7 7h10v10H7zM4 4h3v3H4zM17 17h3v3h-3zM17 4h3v3h-3zM4 17h3v3H4z" />
    </svg>
  )
}

export function Composer() {
  const [text, setText] = createSignal("")
  const [files, setFiles] = createSignal<FileAttachment[]>([])
  const [skills, setSkills] = createSignal<string[]>([])
  const [availableSkills, setAvailableSkills] = createSignal<{ id: string; description: string; origin?: "global" | "project" | "custom" }[]>([])
  const [skillsTick, setSkillsTick] = createSignal(0)
  const [suggestions, setSuggestions] = createSignal<Suggestion[]>([])
  const [suggestionIndex, setSuggestionIndex] = createSignal(0)
  const [popover, setPopover] = createSignal<"none" | "agent" | "model" | "attach">("none")
  const [skillsSubmenu, setSkillsSubmenu] = createSignal(false)
  const [modelQuery, setModelQuery] = createSignal("")
  let textarea: HTMLTextAreaElement | undefined

  // Provider display name: defined before the memos below (Solid memos run eagerly).
  const providerName = (providerID: string) => state.providers.find((provider) => provider.id === providerID)?.name ?? providerID

  // Skills available for the active session (global + project), for `@` mentions.
  // Re-runs when the active session changes or a skill is installed/removed from the UI,
  // and refreshes when the `@` menu or the `+` menu opens, so skills the agent installs
  // mid-session show up without restarting. One IPC scan per menu open; only the latest
  // result wins (generation guard).
  let skillsGeneration = 0
  const refreshSkills = () => {
    const generation = ++skillsGeneration
    void api
      .listSkills(state.activeSessionID ?? "")
      .then((skills) => {
        if (generation !== skillsGeneration) return
        const next = skills.map((skill) => ({ id: skill.id, description: skill.description, origin: skill.origin }))
        const current = availableSkills()
        const changed = next.length !== current.length || next.some((skill, index) => skill.id !== current[index]?.id)
        setAvailableSkills(next)
        // Only re-run the suggestion effect when something actually changed.
        if (changed) setSkillsTick((tick) => tick + 1)
      })
      .catch(() => {})
  }
  createEffect(() => {
    void state.activeSessionID
    void state.skillsRevision
    refreshSkills()
  })

  const agents = createMemo(() => primaryAgents())
  const session = createMemo(() => activeSession())
  const currentAgent = createMemo(() => state.agents.find((agent) => agent.id === session()?.agent))
  const currentModel = createMemo(() => {
    const ref = session()?.model
    if (!ref) return undefined
    return state.models.find((model) => model.providerID === ref.providerID && model.id === ref.modelID)
  })

  const configuredProviders = createMemo(() => new Set(state.providers.filter((provider) => provider.configured).map((provider) => provider.id)))
  /** Models grouped by provider (like the TUI): only connected providers, with separators. */
  const modelGroups = createMemo(() => {
    const query = modelQuery().toLowerCase()
    const groups = new Map<string, ModelInfo[]>()
    for (const model of state.models) {
      if (!configuredProviders().has(model.providerID)) continue
      const provider = providerName(model.providerID)
      if (
        query &&
        !model.id.toLowerCase().includes(query) &&
        !(model.name ?? "").toLowerCase().includes(query) &&
        !provider.toLowerCase().includes(query)
      )
        continue
      const list = groups.get(model.providerID) ?? []
      if (list.length < 100) list.push(model)
      groups.set(model.providerID, list)
    }
    return [...groups.entries()]
      .map(([providerID, models]) => ({ providerID, models }))
      .sort((a, b) => providerName(a.providerID).localeCompare(providerName(b.providerID)))
  })
  const priceLabel = (model: ModelInfo): string => {
    const cost = model.cost
    if (!cost) return ""
    if ((cost.input ?? 0) === 0 && (cost.output ?? 0) === 0) return t("composer.free")
    return `$${cost.input ?? 0}/$${cost.output ?? 0}`
  }
  const recentModels = createMemo(() => {
    const prefs = state.modelPrefs
    if (!prefs) return []
    return prefs.recent
      .map((ref) => state.models.find((model) => model.providerID === ref.providerID && model.id === ref.modelID))
      .filter((model): model is ModelInfo => Boolean(model))
      .slice(0, 5)
  })

  /** Restores the variant remembered for that model (upstream `preferences.variant`). */
  const pickModel = (model: ModelInfo) => {
    const remembered = state.modelPrefs?.variant?.[`${model.providerID}/${model.id}`]
    const variant = remembered && (model.variants ?? []).includes(remembered) ? remembered : undefined
    void setModel(model.providerID, model.id, variant)
    closePopovers()
  }

  /** Cycles thinking variants (keyboard shortcut keeps it reachable without a chip). */
  const cycleVariant = () => {
    void import("../store").then(({ cycleModelVariant }) => cycleModelVariant())
  }
  void cycleVariant

  // Auto-grow textarea (one line by default, grows on wrap/newline up to 260px)
  createEffect(() => {
    text() // track the content so the height follows every change
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`
  })

  // Suggestion detection: `@` shows files, skills and subagents (like upstream),
  // `/` shows commands. File search is server-side over a cached index.
  let mentionWasOpen = false
  createEffect(() => {
    const value = text()
    const cursor = value.length
    const mention = value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/)
    if (!mention) {
      mentionWasOpen = false
    } else {
      const query = mention[1]
      // One scan when the `@` menu opens: a skill the agent installed mid-session shows up
      // without restarting the app. Re-runs when the refreshed list arrives (skillsTick).
      if (!mentionWasOpen) {
        mentionWasOpen = true
        refreshSkills()
      }
      void skillsTick()
      const sessionID = state.activeSessionID
      const needle = query.toLowerCase()
      void (sessionID ? api.findFiles(sessionID, query, 15) : Promise.resolve([])).then((found) => {
        const skillOptions: Suggestion[] = availableSkills()
          .filter((skill) => !needle || skill.id.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
          .slice(0, 6)
          .map((skill) => ({
            kind: "skill",
            value: skill.id,
            label: skill.id,
            description: `${skill.origin === "project" ? t("skills.origin.project") : skill.origin === "custom" ? t("skills.origin.custom") : t("skills.origin.global")} · ${skill.description || "—"}`,
          }))
        const agentOptions: Suggestion[] = state.agents
          .filter((agent) => !agent.hidden && agent.mode !== "primary")
          .filter((agent) => !needle || agent.id.toLowerCase().includes(needle))
          .slice(0, 6)
          .map((agent) => ({ kind: "agent", value: agent.id, label: agent.id, description: agent.description }))
        setSuggestions([
          ...skillOptions,
          ...agentOptions,
          ...found.map((file) => ({ kind: "file" as const, value: file, label: file })),
        ])
        setSuggestionIndex(0)
      })
      return
    }
    const command = value.match(/^\/(\S*)$/)
    if (command) {
      const query = command[1].toLowerCase()
      setSuggestions(COMMANDS.filter((entry) => entry.value.slice(1).startsWith(query)))
      setSuggestionIndex(0)
      return
    }
    setSuggestions([])
  })

  const applySuggestion = (suggestion: Suggestion) => {
    const value = text()
    if (suggestion.kind === "command") {
      setText("")
      void handleCommand(suggestion.value)
      setSuggestions([])
      textarea?.focus()
      return
    }
    if (suggestion.kind === "skill") {
      // Skills attach to the message as a chip (upstream inserts a skill part).
      const stripped = value.replace(/(?:^|\s)@([^\s@]*)$/, (match) => (match.startsWith(" ") ? " " : ""))
      setText(stripped)
      if (!skills().includes(suggestion.value)) setSkills((current) => [...current, suggestion.value])
      setSuggestions([])
      textarea?.focus()
      return
    }
    const replaced = value.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
      const prefix = match.startsWith(" ") ? " " : ""
      return `${prefix}@${suggestion.value} `
    })
    setText(replaced)
    setSuggestions([])
    textarea?.focus()
  }

  const handleCommand = async (command: string) => {
    if (command === "/new") {
      const { createSession } = await import("../store")
      await createSession()
      return
    }
    if (command === "/settings") {
      const { toggleSettings } = await import("../store")
      toggleSettings(true)
      return
    }
    if (command === "/plan") {
      await setAgent("plan")
      return
    }
    if (command === "/build") {
      await setAgent("build")
      return
    }
    if (command === "/skill") {
      const { toggleSkillDialog } = await import("../store")
      toggleSkillDialog(true)
      return
    }
    await runCommand(command)
  }

  const submit = async (delivery?: "steer" | "queue") => {
    const value = text().trim()
    if (!value) return
    const sessionID = session()
    if (!sessionID) return
    if (value.startsWith("!")) {
      setText("")
      await runCommand(value)
      return
    }
    if (value.startsWith("/")) {
      setText("")
      await handleCommand(value.split(/\s+/)[0])
      return
    }
    setText("")
    const attachments = files()
    const attachedSkills = skills()
    setFiles([])
    setSkills([])
    await sendPrompt(value, attachments.length > 0 ? attachments : undefined, delivery, attachedSkills.length > 0 ? attachedSkills : undefined)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const list = suggestions()
    if (list.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSuggestionIndex((index) => (index + 1) % list.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setSuggestionIndex((index) => (index - 1 + list.length) % list.length)
        return
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault()
        applySuggestion(list[suggestionIndex()])
        return
      }
      if (event.key === "Escape") {
        setSuggestions([])
        return
      }
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault()
      cycleAgent(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === "Escape") {
      if (popover() !== "none") {
        setPopover("none")
        return
      }
      if (activeBusy()) {
        event.preventDefault()
        void interrupt()
      }
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      void attachFiles()
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit(event.ctrlKey || event.metaKey ? "queue" : "steer")
    }
  }

  const cycleAgent = (direction: number) => {
    const list = agents()
    if (list.length === 0) return
    const index = list.findIndex((agent) => agent.id === session()?.agent)
    const next = list[(index + direction + list.length) % list.length]
    void setAgent(next.id)
  }

  const onPaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue
      const file = item.getAsFile()
      if (!file) continue
      event.preventDefault()
      const reader = new FileReader()
      reader.onload = () => {
        setFiles((current) => [...current, { type: "file", url: String(reader.result), mime: file.type, name: "pasted-image" }])
      }
      reader.readAsDataURL(file)
    }
  }

  const attachFiles = async () => {
    const picked = await api.pickFiles()
    const attachments: FileAttachment[] = picked
      .filter((file) => file.dataUrl)
      .map((file) => ({ type: "file", url: file.dataUrl!, mime: file.mime, name: file.name }))
    if (attachments.length > 0) setFiles((current) => [...current, ...attachments])
  }

  const closePopovers = () => {
    setPopover("none")
    setModelQuery("")
    setSkillsSubmenu(false)
  }
  onCleanup(closePopovers)

  return (
    <div class="composer-wrap">
      <div class="composer">
        {/* ---------------------------------------------------- suggestions */}
        <Show when={suggestions().length > 0}>
          <div class="suggestions">
            <For each={suggestions()}>
              {(suggestion, index) => (
                <button
                  class={`suggestion ${index() === suggestionIndex() ? "selected" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applySuggestion(suggestion)
                  }}
                >
                  <span>
                    {suggestion.kind === "command" ? "/" : suggestion.kind === "skill" ? <Icon name="skill" size={13} /> : suggestion.kind === "agent" ? "◆" : "@"}
                  </span>
                  <span class="name">{suggestion.label}</span>
                  <Show when={suggestion.description}>
                    <span style={{ "margin-left": "auto", "font-size": "11px", color: "var(--text-faint)" }}>
                      {suggestion.description?.slice(0, 60)}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* ------------------------------------------------------- agent popover */}
        <Show when={popover() === "agent"}>
          <div class="popover" style={{ bottom: "calc(100% + 8px)", left: "0" }} onMouseLeave={closePopovers}>
            <div class="section-label">{t("composer.agent")}</div>
            <For each={agents()}>
              {(agent: AgentInfo) => (
                <button
                  class={`popover-item ${agent.id === session()?.agent ? "selected" : ""}`}
                  onClick={() => {
                    void setAgent(agent.id)
                    closePopovers()
                  }}
                >
                  <span style={{ "font-weight": 600 }}>{agent.name}</span>
                  <span class="sub">{agent.id === "plan" ? "read-only" : ""}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* ------------------------------------------------------- model popover */}
        <Show when={popover() === "model"}>
          <div class="popover" style={{ bottom: "calc(100% + 8px)", right: "0", width: "420px" }} onMouseLeave={closePopovers}>
            <div style={{ padding: "5px" }}>
              <input
                type="text"
                placeholder="Buscar modelo…"
                value={modelQuery()}
                onInput={(event) => setModelQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    closePopovers()
                  }
                }}
                style={{
                  width: "100%",
                  border: "1px solid var(--border)",
                  "border-radius": "6px",
                  background: "var(--bg-inset)",
                  padding: "6px 8px",
                  outline: "none",
                }}
              />
            </div>
            <Show when={modelQuery() === "" && recentModels().length > 0}>
              <div class="section-label">{t("composer.recent")}</div>
              <For each={recentModels()}>
                {(model) => (
                  <button class="popover-item" onClick={() => pickModel(model)}>
                    <span class="name" style={{ "font-family": "var(--font-mono)", "font-size": "12px" }}>{model.id}</span>
                    <span class="sub">{providerName(model.providerID)}</span>
                  </button>
                )}
              </For>
            </Show>
            <For each={modelGroups()}>
              {(group) => (
                <>
                  <div class="section-label provider-label">{providerName(group.providerID)}</div>
                  <For each={group.models}>
                    {(model: ModelInfo) => (
                      <button
                        class={`popover-item ${model.id === currentModel()?.id && model.providerID === session()?.model?.providerID ? "selected" : ""}`}
                        title={`${model.providerID}/${model.id}${priceLabel(model) ? ` · ${priceLabel(model)} ${t("composer.priceHint")}` : ""}`}
                        onClick={() => pickModel(model)}
                      >
                        <span class="name">{model.name && model.name !== model.id ? model.name : model.id}</span>
                        <Show when={model.discovered}>
                          <span class="badge discovered">{t("settings.models.discovered")}</span>
                        </Show>
                        <Show when={model.name && model.name !== model.id}>
                          <span class="sub" style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}>{model.id}</span>
                        </Show>
                        <Show when={priceLabel(model)}>
                          <span class={`price${priceLabel(model) === t("composer.free") ? " free" : ""}`}>{priceLabel(model)}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
            <Show when={modelGroups().length === 0}>
              <div class="popover-item placeholder" style={{ color: "var(--text-faint)" }}>
                {t("composer.noModel")}
              </div>
            </Show>
          </div>
        </Show>

        <Show when={popover() === "attach"}>
          <div class="popover attach-menu" onClick={(event) => event.stopPropagation()}>
            <button
              class="popover-item"
              onClick={() => {
                closePopovers()
                void attachFiles()
              }}
            >
              <Icon name="paperclip" size={13} />
              <span class="name">{t("composer.attachFiles")}</span>
              <span class="sub">Ctrl+U</span>
            </button>
            <div class="skills-submenu-zone" onMouseLeave={() => setSkillsSubmenu(false)}>
              <div
                class={`popover-item skills-parent${skillsSubmenu() ? " selected" : ""}`}
                onMouseEnter={() => setSkillsSubmenu(true)}
                onClick={() => setSkillsSubmenu(!skillsSubmenu())}
              >
                <Icon name="skill" size={13} />
                <span class="name">{t("skills.title")}</span>
                <span class="sub">›</span>
              </div>
              <Show when={skillsSubmenu()}>
                <div class="popover-submenu">
                  <div class="section-label">{t("skills.installed")}</div>
                  <Show
                    when={availableSkills().length > 0}
                    fallback={
                      <div class="popover-item" style={{ color: "var(--text-faint)" }}>
                        {t("skills.none")}
                      </div>
                    }
                  >
                    <For each={availableSkills()}>
                    {(skill) => (
                      <button
                        class="popover-item"
                        title={skill.description}
                        onClick={() => {
                          if (!skills().includes(skill.id)) setSkills((current) => [...current, skill.id])
                          closePopovers()
                        }}
                      >
                        <Icon name="skill" size={13} />
                        <span class="name">{skill.id}</span>
                      </button>
                    )}
                  </For>
                  </Show>
                  <div class="menu-separator" />
                  <button
                    class="popover-item"
                    onClick={() => {
                      toggleSkillDialog(true, "list")
                      closePopovers()
                    }}
                  >
                    <Icon name="gear" size={13} />
                    <span class="name">{t("skills.manage")}</span>
                  </button>
                  <button
                    class="popover-item"
                    onClick={() => {
                      toggleSkillDialog(true, "create")
                      closePopovers()
                    }}
                  >
                    <Icon name="plus" size={13} />
                    <span class="name">{t("skills.explore")}</span>
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <div class="composer-box">
          <Show when={files().length > 0 || skills().length > 0}>
            <div class="composer-attachments">
              <For each={skills()}>
                {(skill) => (
                  <span class="composer-attachment" style={{ "border-color": "var(--accent)" }}>
                    <Icon name="skill" size={12} />
                    <span>{skill}</span>
                    <button class="icon-button" onClick={() => setSkills((current) => current.filter((entry) => entry !== skill))}>
                      ✕
                    </button>
                  </span>
                )}
              </For>
              <For each={files()}>
                {(file, index) => (
                  <span class="composer-attachment">
                    <Show when={file.mime.startsWith("image/")}>
                      <img src={file.url} alt={file.name ?? ""} />
                    </Show>
                    <span>{file.name ?? file.mime}</span>
                    <button class="icon-button" onClick={() => setFiles((current) => current.filter((_, i) => i !== index()))}>
                      ✕
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={text().trimStart().startsWith("!") && text().trim().length > 1}>
            <div class="composer-shell-hint">⏎ {t("composer.shellHint")}</div>
          </Show>
          <textarea
            ref={textarea}
            rows={1}
            value={text()}
            placeholder={t("composer.placeholder")}
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div class="composer-footer">
            <button
              class="composer-chip"
              onClick={() => setPopover(popover() === "agent" ? "none" : "agent")}
              title={t("composer.agent")}
            >
              <AgentIcon />
              <span class="value">{currentAgent()?.name ?? session()?.agent ?? "build"}</span>
            </button>
            <button
              class="composer-chip"
              onClick={() => setPopover(popover() === "model" ? "none" : "model")}
              title={t("composer.model")}
            >
              <ProviderIcon />
              <span class="value">
                {currentModel()?.id ?? session()?.model?.modelID ?? t("composer.noModel")}
              </span>
            </button>
            <Show when={currentModel()?.variants?.length}>
              <select
                class="composer-chip"
                value={session()?.model?.variant ?? "default"}
                onChange={(event) => {
                  const ref = session()?.model
                  if (!ref) return
                  void setModel(ref.providerID, ref.modelID, event.currentTarget.value || undefined)
                }}
                title={t("composer.variant")}
              >
                <option value="default">{t("composer.default")}</option>
                <For each={currentModel()?.variants ?? []}>{(variant) => <option value={variant}>{variantLabel(variant)}</option>}</For>
              </select>
            </Show>
            <button
              class={`composer-chip${popover() === "attach" ? " active" : ""}`}
              onClick={() => {
                const open = popover() !== "attach"
                if (open) refreshSkills()
                setPopover(open ? "attach" : "none")
              }}
              title={t("composer.attach")}
            >
              <Icon name="plus" size={14} />
            </button>
            <span style={{ flex: 1 }} />
            <Switch>
              <Match when={activeBusy()}>
                <button class="send-button stop" onClick={() => void interrupt()} title={t("app.stop")}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              </Match>
              <Match when={true}>
                <button
                  class="send-button"
                  disabled={!text().trim() || !session()}
                  onClick={() => void submit()}
                  title={`${t("app.send")} (Enter) · ${t("app.queue")} (Ctrl+Enter)`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </div>
  )
}
