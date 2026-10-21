import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  ModelInfo,
  ModelRef,
  ScheduledRun,
  ScheduledTask,
  ScheduleRepeat,
  ScheduleTaskView,
} from "@openorch/shared"
import { api } from "../api"
import { t, variantLabel } from "../i18n"
import { closeSchedule, openScheduledSession, refreshConfig, requestConfirm, state } from "../store"
import { Icon } from "./Icons"
import { createModelCatalog, ModelOptions } from "./ModelCatalog"

type Mode = "empty" | "detail" | "form"
type RepeatKind = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "once"

interface Draft {
  instruction: string
  repeatKind: RepeatKind
  days: number[]
  monthDay: number
  hourInterval: number
  onceDate: string
  time: string
  workspace: string
  modelKey: string
  variant: string
  notify: boolean
  background: boolean
  newChat: boolean
  startWithWindows: boolean
  title: string
}

const WEEKDAYS = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "X" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
]

function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function fallbackTitle(instruction: string): string {
  const first = instruction.trim().split("\n")[0] ?? ""
  return first.replace(/^["'#\s]+|["'\s]+$/g, "").slice(0, 80) || "Tarea programada"
}

function repeatLabel(repeat: ScheduleRepeat): string {
  switch (repeat.kind) {
    case "daily":
      return t("schedule.repeat.daily")
    case "weekdays":
      return t("schedule.repeat.weekdays")
    case "weekly": {
      const names = repeat.days
        .map((day) => WEEKDAYS.find((entry) => entry.value === day)?.label ?? "")
        .filter(Boolean)
        .join(" ")
      return `${t("schedule.repeat.weekly")} · ${names}`
    }
    case "monthly":
      return `${t("schedule.repeat.monthly")} · ${repeat.day}`
    case "hourly":
      return t("schedule.repeat.hourly", { count: repeat.interval })
    case "once":
      return `${t("schedule.repeat.once")} · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(repeat.at)}`
  }
}

function nextRunLabel(task: ScheduledTask): string {
  if (!task.enabled) return t("schedule.detail.paused")
  if (!task.nextRunAt) return t("schedule.detail.none")
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: task.timeZone,
  }).format(new Date(task.nextRunAt))
}

function runLabel(run: ScheduledRun): string {
  if (run.status === "running") return t("schedule.detail.running")
  if (run.status === "failed") return t("schedule.detail.failed")
  if (run.status === "interrupted") return t("schedule.detail.interrupted")
  return t("schedule.detail.success")
}

function runClass(run: ScheduledRun): string {
  if (run.status === "running") return "warn"
  if (run.status === "failed") return "err"
  if (run.status === "interrupted") return "warn"
  return "ok"
}

export function ScheduleDialog() {
  const [tasks, setTasks] = createSignal<ScheduledTask[]>([])
  const [selected, setSelected] = createSignal<ScheduleTaskView | undefined>()
  const [mode, setMode] = createSignal<Mode>("empty")
  const [search, setSearch] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [advanced, setAdvanced] = createSignal(false)
  const [taskMenu, setTaskMenu] = createSignal<{ task: ScheduledTask; x: number; y: number } | undefined>()
  const [editing, setEditing] = createSignal<ScheduledTask | undefined>()
  const [draft, setDraft] = createStore<Draft>(newDraft())

  function defaultModel(models: ModelInfo[] = state.models ?? []): ModelInfo | undefined {
    const active = state.sessions.find((session) => session.id === state.activeSessionID)?.model
    const remembered = state.modelPrefs?.recent?.[0]
    for (const ref of [active, remembered]) {
      if (!ref) continue
      const model = models.find((entry) => entry.providerID === ref.providerID && entry.id === ref.modelID)
      if (model) return model
    }
    return models[0]
  }

  function newDraft(task?: ScheduledTask): Draft {
    const base = task
    const model = base?.model
      ? state.models.find((entry) => entry.providerID === base.model?.providerID && entry.id === base.model?.modelID)
      : defaultModel()
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const storedVariant = model ? state.modelPrefs?.variant?.[`${model.providerID}/${model.id}`] : undefined
    const variant = base?.model?.variant ?? (storedVariant && model?.variants?.includes(storedVariant) ? storedVariant : "")
    return {
      instruction: base?.instruction ?? "",
      repeatKind: base?.repeat.kind ?? "daily",
      days:
        base?.repeat.kind === "weekly"
          ? [...base.repeat.days]
          : base?.repeat.kind === "weekdays"
            ? [1, 2, 3, 4, 5]
            : [now.getDay()],
      monthDay: base?.repeat.kind === "monthly" ? base.repeat.day : now.getDate(),
      hourInterval: base?.repeat.kind === "hourly" ? base.repeat.interval : 2,
      onceDate:
        base?.repeat.kind === "once"
          ? localDate(new Date(base.repeat.at))
          : localDate(tomorrow),
      time: base?.time ?? "09:00",
      workspace: base?.workspace ?? state.workspace ?? state.config?.lastDirectory ?? "",
      modelKey: model ? `${model.providerID}/${model.id}` : "",
      variant,
      notify: base?.notify ?? true,
      background: base?.background ?? true,
      newChat: base?.newChatEachRun ?? true,
      startWithWindows: base ? (state.config?.schedule?.startWithWindows ?? false) : true,
      title: base?.title ?? "",
    }
  }

  function resetDraft(task?: ScheduledTask): void {
    const next = newDraft(task)
    setDraft(next)
  }

  const catalog = createModelCatalog()
  const selectedModel = createMemo(() => {
    const [providerID, modelID] = draft.modelKey.split("/")
    return catalog.models().find((model) => model.providerID === providerID && model.id === modelID)
  })
  const variantOptions = createMemo(() => selectedModel()?.variants ?? [])
  const filteredTasks = createMemo(() => {
    const query = search().trim().toLowerCase()
    if (!query) return tasks()
    return tasks().filter((task) => `${task.title}\n${task.instruction}`.toLowerCase().includes(query))
  })
  const enabledTasks = createMemo(() => filteredTasks().filter((task) => task.enabled))
  const pausedTasks = createMemo(() => filteredTasks().filter((task) => !task.enabled))
  const systemTimeZone = systemZone()

  createEffect(() => {
    const models = catalog.models()
    if (models.length === 0 || draft.modelKey) return
    const model = defaultModel(models)
    if (!model) return
    const key = `${model.providerID}/${model.id}`
    const remembered = state.modelPrefs?.variant?.[key]
    setDraft("modelKey", key)
    setDraft("variant", remembered && model.variants?.includes(remembered) ? remembered : "")
  })

  function modelRef(): ModelRef | undefined {
    const model = selectedModel()
    if (!model) return undefined
    return {
      providerID: model.providerID,
      modelID: model.id,
      ...(draft.variant ? { variant: draft.variant } : {}),
    }
  }

  function buildRepeat(): ScheduleRepeat {
    switch (draft.repeatKind) {
      case "daily":
        return { kind: "daily" }
      case "weekdays":
        return { kind: "weekdays" }
      case "weekly":
        return { kind: "weekly", days: [...draft.days].sort((left, right) => left - right) }
      case "monthly":
        return { kind: "monthly", day: draft.monthDay }
      case "hourly":
        return { kind: "hourly", interval: draft.hourInterval }
      case "once":
        return { kind: "once", at: new Date(`${draft.onceDate}T${draft.time}:00`).getTime() }
    }
  }

  async function loadTasks(): Promise<void> {
    try {
      setTasks(await api.schedule.list())
      setError("")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function selectTask(taskID: string): Promise<void> {
    setSelected(undefined)
    setMode("detail")
    setBusy(true)
    try {
      const view = await api.schedule.view(taskID)
      if (!view) {
        await loadTasks()
        setMode("empty")
        return
      }
      setSelected(view)
      setError("")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function refreshDetail(taskID: string): Promise<void> {
    try {
      const view = await api.schedule.view(taskID)
      if (view) setSelected(view)
      else {
        setSelected(undefined)
        setMode("empty")
      }
      await loadTasks()
    } catch {
      // Polling is best-effort.
    }
  }

  /**
   * Clicking a task in the sidebar opens the same form as "Nueva tarea", but
   * prefilled with that task: the primary action becomes "Guardar cambios" and
   * saving updates the existing task instead of creating a new one.
   */
  async function openTaskForEdit(taskID: string): Promise<void> {
    setTaskMenu(undefined)
    setBusy(true)
    try {
      const view = await api.schedule.view(taskID)
      if (!view) {
        await loadTasks()
        setMode("empty")
        return
      }
      setSelected(view)
      setError("")
      startEdit(view.task)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  function startNew(): void {
    setEditing(undefined)
    setTaskMenu(undefined)
    resetDraft()
    setError("")
    setMode("form")
  }

  function startEdit(task: ScheduledTask): void {
    setEditing(task)
    setTaskMenu(undefined)
    resetDraft(task)
    setError("")
    setMode("form")
  }

  function validate(): boolean {
    if (!draft.instruction.trim() || !draft.workspace.trim()) {
      setError(t("schedule.form.required"))
      return false
    }
    if (draft.repeatKind === "weekly" && draft.days.length === 0) {
      setError(t("schedule.form.required"))
      return false
    }
    if (draft.repeatKind === "once") {
      const at = new Date(`${draft.onceDate}T${draft.time}:00`).getTime()
      if (!Number.isFinite(at) || at <= Date.now()) {
        setError(t("schedule.form.required"))
        return false
      }
    }
    return true
  }

  function payload() {
    const instruction = draft.instruction.trim()
    return {
      title: draft.title.trim() || fallbackTitle(instruction),
      instruction,
      originalInstruction: editing()?.originalInstruction ?? instruction,
      repeat: buildRepeat(),
      time: draft.time,
      timeZone: systemTimeZone,
      workspace: draft.workspace.trim(),
      model: modelRef(),
      notify: draft.notify,
      background: draft.background,
      newChatEachRun: draft.newChat,
      enabled: editing()?.enabled ?? true,
    }
  }

  async function save(): Promise<void> {
    if (!validate()) return
    setBusy(true)
    setError("")
    try {
      if (draft.background && draft.startWithWindows !== (state.config?.schedule?.startWithWindows ?? false)) {
        await api.schedule.startup(draft.startWithWindows).catch((failure) => {
          setError(failure instanceof Error ? failure.message : String(failure))
        })
        await refreshConfig().catch(() => undefined)
      }
      const body = payload()
      const task = editing() ? await api.schedule.update(editing()!.id, body) : await api.schedule.create(body)
      await loadTasks()
      await selectTask(task.id)
      setEditing(undefined)
      setMode("detail")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setMode("form")
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled(task: ScheduledTask): Promise<void> {
    setTaskMenu(undefined)
    setBusy(true)
    try {
      await api.schedule.setEnabled(task.id, !task.enabled)
      if (selected()?.task.id === task.id) await refreshDetail(task.id)
      else await loadTasks()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  async function runNow(task: ScheduledTask): Promise<void> {
    setTaskMenu(undefined)
    setBusy(true)
    try {
      await api.schedule.runNow(task.id)
      setError("")
      await loadTasks()
      if (selected()?.task.id === task.id) await refreshDetail(task.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  function openTaskMenu(event: MouseEvent, task: ScheduledTask): void {
    event.stopPropagation()
    if (taskMenu()?.task.id === task.id) {
      setTaskMenu(undefined)
      return
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const width = 208
    const estimatedHeight = 150
    const x = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
    const y =
      rect.bottom + 6 + estimatedHeight > window.innerHeight
        ? Math.max(8, rect.top - 6 - estimatedHeight)
        : rect.bottom + 6
    setTaskMenu({ task, x, y })
  }

  function removeTask(task: ScheduledTask): void {
    setTaskMenu(undefined)
    requestConfirm({
      title: t("schedule.detail.delete"),
      message: t("schedule.detail.deleteConfirm", { title: task.title }),
      note: t("schedule.detail.deleteHint"),
      confirmLabel: t("schedule.detail.delete"),
      danger: true,
      onConfirm: async () => {
        setBusy(true)
        try {
          await api.schedule.remove(task.id)
          if (selected()?.task.id === task.id) {
            setSelected(undefined)
            setMode("empty")
          }
          await loadTasks()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  async function openChat(task: ScheduledTask): Promise<void> {
    const sessionID = selected()?.runs.find((run) => run.sessionID)?.sessionID ?? task.sessionID
    if (!sessionID) return
    await openScheduledSession(task.workspace, sessionID)
  }

  async function pickWorkspace(): Promise<void> {
    const directory = await api.pickDirectory().catch(() => null)
    if (!directory) return
    setDraft("workspace", directory)
  }

  async function dropWorkspace(event: DragEvent): Promise<void> {
    event.preventDefault()
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    const target = window.openorch.pathForFile(file)
    if (!target || !(await api.isDirectory(target))) {
      setError(t("schedule.form.invalidFolder"))
      return
    }
    setDraft("workspace", target)
    setError("")
  }

  async function toggleStartup(enabled: boolean): Promise<void> {
    setDraft("startWithWindows", enabled)
  }

  function suggestions() {
    return [
      {
        title: t("schedule.suggest.daily"),
        description: t("schedule.suggest.dailyDescription"),
        instruction: "Revisa el estado de este proyecto y hazme un resumen breve con lo importante y los siguientes pasos.",
      },
      {
        title: t("schedule.suggest.weekly"),
        description: t("schedule.suggest.weeklyDescription"),
        instruction: "Revisa el trabajo de esta semana en el proyecto y prepara una actualización breve de estado.",
      },
      {
        title: t("schedule.suggest.research"),
        description: t("schedule.suggest.researchDescription"),
        instruction: "Busca en internet las novedades más relevantes sobre este tema y envíame un resumen con enlaces.",
      },
    ]
  }

  function useSuggestion(instruction: string): void {
    setEditing(undefined)
    resetDraft()
    setDraft("instruction", instruction)
    setMode("form")
  }

  onMount(() => {
    void loadTasks()
    const onDocumentClick = (event: MouseEvent) => {
      if (!taskMenu()) return
      const target = event.target as HTMLElement | null
      if (!target?.closest(".schedule-task-menu") && !target?.closest(".schedule-row-menu-button")) setTaskMenu(undefined)
    }
    document.addEventListener("click", onDocumentClick)
    onCleanup(() => document.removeEventListener("click", onDocumentClick))
  })

  // Poll only while the window is open; a closed modal must not keep a timer alive.
  createEffect(() => {
    if (!state.scheduleOpen) return
    const timer = window.setInterval(() => {
      if (mode() === "detail" && selected()) void refreshDetail(selected()!.task.id)
    }, 5_000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    if (!state.scheduleOpen) {
      setTaskMenu(undefined)
      return
    }
    if (state.scheduleTaskID) {
      const taskID = state.scheduleTaskID
      void selectTask(taskID)
    } else if (mode() === "empty" || mode() === "detail") {
      void loadTasks()
      if (!selected()) setMode("empty")
    }
  })

  createEffect(() => {
    if (!state.scheduleOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (taskMenu()) {
          setTaskMenu(undefined)
          return
        }
        closeSchedule()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const taskSummary = (task: ScheduledTask) =>
    task.repeat.kind === "hourly" ? repeatLabel(task.repeat) : `${repeatLabel(task.repeat)} · ${task.time}`

  return (
    <Show when={state.scheduleOpen}>
      <div class="modal-backdrop" onClick={() => closeSchedule()}>
        <div class="modal schedule-modal" onClick={(event) => event.stopPropagation()}>
          <button class="modal-close icon-button" title={t("app.close")} onClick={() => closeSchedule()}>
            ✕
          </button>

          <aside class="schedule-sidebar">
            <div class="schedule-sidebar-head">
              <div class="schedule-heading">
                <Icon name="calendar" size={16} />
                <span>{t("schedule.title")}</span>
              </div>
              <div class="schedule-search">
                <Icon name="search" size={13} />
                <input type="search" placeholder={t("schedule.search")} value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
              </div>
            </div>
            <button class="schedule-new" onClick={startNew}>
              <Icon name="plus" size={14} />
              {t("schedule.new")}
            </button>
            <div class="schedule-list">
              <Show when={enabledTasks().length > 0}>
                <div class="schedule-section-label">
                  <span>{t("schedule.upcoming")}</span>
                  <Icon name="clock" size={12} />
                </div>
                <For each={enabledTasks()}>
                  {(task) => (
                    <div
                      class={`schedule-row${selected()?.task.id === task.id && (mode() === "detail" || mode() === "form") ? " active" : ""}`}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest(".schedule-row-menu-button")) return
                        void openTaskForEdit(task.id)
                      }}
                    >
                      <div class="schedule-row-main">
                        <span class="schedule-row-title">{task.title}</span>
                        <span class="schedule-row-meta">
                          {nextRunLabel(task)} · {repeatLabel(task.repeat)}
                        </span>
                      </div>
                      <Show when={task.lastStatus === "running"}>
                        <span class="schedule-running-dot" title={t("schedule.detail.running")} />
                      </Show>
                      <button
                        type="button"
                        class="schedule-row-menu-button"
                        title={t("schedule.row.menu")}
                        aria-label={t("schedule.row.menu")}
                        onClick={(event) => openTaskMenu(event, task)}
                      >
                        ⋯
                      </button>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={pausedTasks().length > 0}>
                <div class="schedule-section-label">
                  <span>{t("schedule.detail.paused")}</span>
                  <Icon name="pause" size={12} />
                </div>
                <For each={pausedTasks()}>
                  {(task) => (
                    <div
                      class={`schedule-row paused${selected()?.task.id === task.id && (mode() === "detail" || mode() === "form") ? " active" : ""}`}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest(".schedule-row-menu-button")) return
                        void openTaskForEdit(task.id)
                      }}
                    >
                      <div class="schedule-row-main">
                        <span class="schedule-row-title">{task.title}</span>
                        <span class="schedule-row-meta">{taskSummary(task)}</span>
                      </div>
                      <button
                        type="button"
                        class="schedule-row-menu-button"
                        title={t("schedule.row.menu")}
                        aria-label={t("schedule.row.menu")}
                        onClick={(event) => openTaskMenu(event, task)}
                      >
                        ⋯
                      </button>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={filteredTasks().length === 0}>
                <div class="schedule-list-empty">{t("schedule.empty")}</div>
              </Show>
            </div>
          </aside>

          <main class="schedule-main">
            <Show when={error()}>
              <div class="schedule-banner error">{error()}</div>
            </Show>

            <Show when={mode() === "empty"}>
              <div class="schedule-empty">
                <div class="schedule-empty-icon">
                  <Icon name="clock" size={34} />
                </div>
                <h2>{t("schedule.emptyTitle")}</h2>
                <p>{t("schedule.emptySubtitle")}</p>
                <div class="schedule-suggestions">
                  <For each={suggestions()}>
                    {(suggestion) => (
                      <button class="schedule-suggestion" onClick={() => useSuggestion(suggestion.instruction)}>
                        <span class="schedule-suggestion-icon">
                          <Icon name={suggestion.title === t("schedule.suggest.daily") ? "clock" : suggestion.title === t("schedule.suggest.weekly") ? "calendar" : "search"} size={17} />
                        </span>
                        <span>
                          <b>{suggestion.title}</b>
                          <small>{suggestion.description}</small>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={mode() === "detail" && selected()}>
              {(view) => {
                const task = () => view().task
                return (
                  <div class="schedule-detail">
                    <div class="schedule-detail-head">
                      <div>
                        <h2>{task().title}</h2>
                        <p class={`schedule-status ${task().enabled ? "success" : "paused"}`}>
                          {task().enabled ? nextRunLabel(task()) : t("schedule.detail.paused")}
                        </p>
                      </div>
                      <div class="schedule-detail-actions">
                        <button class="button" disabled={busy()} onClick={() => void runNow(task())}>
                          <Icon name="play" size={13} /> {t("schedule.detail.runNow")}
                        </button>
                        <button class="button" disabled={busy()} onClick={() => startEdit(task())}>
                          {t("schedule.detail.edit")}
                        </button>
                        <button class="button" disabled={busy()} onClick={() => void toggleEnabled(task())}>
                          <Icon name={task().enabled ? "pause" : "play"} size={13} />
                          {task().enabled ? t("schedule.detail.pause") : t("schedule.detail.resume")}
                        </button>
                        <button class="button danger" disabled={busy()} onClick={() => removeTask(task())} title={t("schedule.detail.delete")}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>

                    <div class="schedule-instruction">{task().instruction}</div>

                    <div class="schedule-meta-grid">
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.schedule")}</span>
                        <b>{taskSummary(task())}</b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.next")}</span>
                        <b>{nextRunLabel(task())}</b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.last")}</span>
                        <b>
                          {task().lastRunAt
                            ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(task().lastRunAt!)
                            : t("schedule.detail.never")}
                        </b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.workspace")}</span>
                        <b title={task().workspace}>{task().workspace}</b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.model")}</span>
                        <b>
                          {task().model
                            ? `${state.models.find((model) => model.providerID === task().model?.providerID && model.id === task().model?.modelID)?.name ?? task().model?.modelID}${task().model?.variant ? ` · ${variantLabel(task().model!.variant!)}` : ""}`
                            : "—"}
                        </b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.background")}</span>
                        <b>{task().background ? t("schedule.yes") : t("schedule.no")}</b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.notify")}</span>
                        <b>{task().notify ? t("schedule.yes") : t("schedule.no")}</b>
                      </div>
                      <div class="schedule-meta">
                        <span>{t("schedule.detail.newChat")}</span>
                        <b>{task().newChatEachRun ? t("schedule.yes") : t("schedule.no")}</b>
                      </div>
                    </div>

                    <div class="schedule-runs-head">
                      <h3>{t("schedule.detail.runs")}</h3>
                      <Show when={task().sessionID}>
                        <button class="button" onClick={() => void openChat(task())}>
                          {t("schedule.detail.openChat")}
                        </button>
                      </Show>
                    </div>
                    <Show when={view().runs.length > 0} fallback={<p class="schedule-muted">{t("schedule.detail.noRuns")}</p>}>
                      <div class="schedule-runs">
                        <For each={view().runs}>
                          {(run) => (
                            <div class="schedule-run">
                              <span class={`status-dot ${runClass(run)}`} />
                              <div class="schedule-run-main">
                                <div>
                                  <b>{runLabel(run)}</b>
                                  <span class="schedule-run-date">
                                    {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(run.startedAt)}
                                  </span>
                                </div>
                                <Show when={run.summary || run.error}>
                                  <p>{run.error || run.summary}</p>
                                </Show>
                              </div>
                              <button class="button" onClick={() => void openScheduledSession(task().workspace, run.sessionID)}>
                                {t("schedule.detail.openChat")}
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </Show>

            <Show when={mode() === "form"}>
              <div class="schedule-form">
                <div class="schedule-form-head">
                  <h2>{editing() ? t("schedule.form.editTitle") : t("schedule.form.createTitle")}</h2>
                </div>

                <Show when={mode() === "form"}>
                  <label class="schedule-field">
                    <span>{t("schedule.form.titleLabel")}</span>
                    <input
                      type="text"
                      value={draft.title}
                      placeholder={t("schedule.form.titlePlaceholder")}
                      onInput={(event) => setDraft("title", event.currentTarget.value)}
                      disabled={busy()}
                    />
                  </label>

                  <label class="schedule-field">
                    <span>{t("schedule.form.instructions")}</span>
                    <textarea
                      rows={5}
                      placeholder={t("schedule.form.instructionsPlaceholder")}
                      value={draft.instruction}
                      onInput={(event) => setDraft("instruction", event.currentTarget.value)}
                      disabled={busy()}
                    />
                  </label>

                  <div class="schedule-box">
                    <div class="schedule-row-field">
                      <span>{t("schedule.form.repeat")}</span>
                      <select
                        value={draft.repeatKind}
                        onChange={(event) => setDraft("repeatKind", event.currentTarget.value as RepeatKind)}
                        disabled={busy()}
                      >
                        <option value="daily">{t("schedule.form.repeat.daily")}</option>
                        <option value="weekdays">{t("schedule.form.repeat.weekdays")}</option>
                        <option value="weekly">{t("schedule.form.repeat.weekly")}</option>
                        <option value="monthly">{t("schedule.form.repeat.monthly")}</option>
                        <option value="hourly">{t("schedule.form.repeat.hourly")}</option>
                        <option value="once">{t("schedule.form.repeat.once")}</option>
                      </select>
                    </div>
                    <Show when={draft.repeatKind === "weekly"}>
                      <div class="schedule-row-field">
                        <span>{t("schedule.form.days")}</span>
                        <div class="schedule-chips">
                          <For each={WEEKDAYS}>
                            {(day) => (
                              <button
                                type="button"
                                class={`schedule-chip${draft.days.includes(day.value) ? " active" : ""}`}
                                onClick={() =>
                                  setDraft("days", draft.days.includes(day.value) ? draft.days.filter((value) => value !== day.value) : [...draft.days, day.value])
                                }
                              >
                                {day.label}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                    <Show when={draft.repeatKind === "monthly"}>
                      <div class="schedule-row-field">
                        <span>{t("schedule.form.monthDay")}</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={draft.monthDay}
                          onInput={(event) => setDraft("monthDay", Math.min(31, Math.max(1, Number(event.currentTarget.value) || 1)))}
                        />
                      </div>
                    </Show>
                    <Show when={draft.repeatKind === "hourly"}>
                      <div class="schedule-row-field">
                        <span>{t("schedule.form.interval")}</span>
                        <input
                          type="number"
                          min={1}
                          max={23}
                          value={draft.hourInterval}
                          onInput={(event) => setDraft("hourInterval", Math.min(23, Math.max(1, Number(event.currentTarget.value) || 1)))}
                        />
                      </div>
                    </Show>
                    <Show when={draft.repeatKind === "once"}>
                      <div class="schedule-row-field">
                        <span>{t("schedule.form.date")}</span>
                        <input type="date" value={draft.onceDate} onInput={(event) => setDraft("onceDate", event.currentTarget.value)} />
                      </div>
                    </Show>
                    <Show when={draft.repeatKind !== "hourly"}>
                      <div class="schedule-row-field">
                        <span>{t("schedule.form.time")}</span>
                        <input type="time" value={draft.time} onInput={(event) => setDraft("time", event.currentTarget.value)} />
                      </div>
                    </Show>
                  </div>

                  <div class="schedule-field">
                    <span>{t("schedule.form.workspace")}</span>
                    <div
                      class={`schedule-drop${draft.workspace ? " filled" : ""}`}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void dropWorkspace(event)}
                    >
                      <Icon name="folder" size={18} />
                      <div class="schedule-drop-text">
                        <Show when={draft.workspace} fallback={<span>{t("schedule.form.workspacePlaceholder")}</span>}>
                          <b title={draft.workspace}>{draft.workspace}</b>
                          <small>{t("schedule.form.drop")}</small>
                        </Show>
                      </div>
                      <button type="button" class="button" onClick={() => void pickWorkspace()}>
                        {t("schedule.form.chooseFolder")}
                      </button>
                    </div>
                  </div>

                  <button type="button" class="schedule-advanced-toggle" onClick={() => setAdvanced(!advanced())}>
                    {t("schedule.form.advanced")}
                    <span>{advanced() ? "▾" : "▸"}</span>
                  </button>

                  <Show when={advanced()}>
                    <div class="schedule-advanced">
                      <div class="schedule-toggle-row">
                        <div>
                          <b>{t("schedule.form.background")}</b>
                          <small>{t("schedule.form.backgroundHint")}</small>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={draft.background}
                          class={`schedule-switch${draft.background ? " on" : ""}`}
                          onClick={() => setDraft("background", !draft.background)}
                        >
                          <span />
                        </button>
                      </div>
                      <label class="schedule-check-row">
                        <input
                          type="checkbox"
                          checked={draft.startWithWindows}
                          disabled={!draft.background}
                          onChange={(event) => void toggleStartup(event.currentTarget.checked)}
                        />
                        <span>
                          <b>{t("schedule.form.startWithWindows")}</b>
                          <small>{t("schedule.form.startWithWindowsHint")}</small>
                        </span>
                      </label>
                      <label class="schedule-check-row">
                        <input type="checkbox" checked={draft.notify} onChange={(event) => setDraft("notify", event.currentTarget.checked)} />
                        <span>
                          <b>{t("schedule.form.notify")}</b>
                          <small>{t("schedule.form.notifyHint")}</small>
                        </span>
                      </label>
                      <label class="schedule-check-row">
                        <input type="checkbox" checked={draft.newChat} onChange={(event) => setDraft("newChat", event.currentTarget.checked)} />
                        <span>
                          <b>{t("schedule.form.newChat")}</b>
                          <small>{t("schedule.form.newChatHint")}</small>
                        </span>
                      </label>
                      <div class="schedule-two">
                        <label class="schedule-field">
                          <span>{t("schedule.form.model")}</span>
                          <select
                            value={draft.modelKey}
                            onChange={(event) => {
                              const key = event.currentTarget.value
                              const model = state.models.find((entry) => `${entry.providerID}/${entry.id}` === key)
                              const remembered = model ? state.modelPrefs?.variant?.[key] : undefined
                              setDraft("modelKey", key)
                              setDraft("variant", remembered && model?.variants?.includes(remembered) ? remembered : "")
                            }}
                          >
                            <option value="" disabled>{t("schedule.form.chooseModel")}</option>
                            <Show when={draft.modelKey && !catalog.models().some((model) => `${model.providerID}/${model.id}` === draft.modelKey)}>
                              <option value={draft.modelKey}>{draft.modelKey}</option>
                            </Show>
                            <ModelOptions models={catalog.models()} />
                          </select>
                          <Show when={catalog.models().length === 0}>
                            <span class="schedule-hint">
                              {catalog.loading()
                                ? t("schedule.form.modelsLoading")
                                : catalog.error() || t("schedule.form.modelsEmpty")}
                            </span>
                            <button type="button" class="button" onClick={() => void catalog.refresh()}>
                              {t("schedule.form.refreshModels")}
                            </button>
                          </Show>
                        </label>
                        <label class="schedule-field">
                          <span>{t("schedule.form.effort")}</span>
                          <select value={draft.variant} onChange={(event) => setDraft("variant", event.currentTarget.value)}>
                            <option value="">{t("schedule.form.defaultEffort")}</option>
                            <For each={variantOptions()}>{(variant) => <option value={variant}>{variantLabel(variant)}</option>}</For>
                          </select>
                        </label>
                      </div>
                    </div>
                  </Show>
                </Show>

                <Show when={mode() === "form"}>
                  <div class="schedule-form-actions">
                    <button
                      class="button"
                      onClick={() => {
                        // Leaving the form discards the pending changes and shows
                        // the task detail (or closes the window for a new task).
                        setEditing(undefined)
                        if (selected()) setMode("detail")
                        else closeSchedule()
                      }}
                      disabled={busy()}
                    >
                      {t("schedule.form.cancel")}
                    </button>
                    <button class="button primary" onClick={() => void save()} disabled={busy()}>
                      {busy() ? t("schedule.form.creating") : editing() ? t("schedule.form.save") : t("schedule.form.create")}
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          </main>

          <Show when={taskMenu()}>
            {(entry) => {
              const task = () => entry().task
              return (
                <div
                  class="popover schedule-task-menu"
                  role="menu"
                  style={{ position: "fixed", left: `${entry().x}px`, top: `${entry().y}px` }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button class="popover-item" role="menuitem" disabled={busy()} onClick={() => void toggleEnabled(task())}>
                    <Icon name={task().enabled ? "pause" : "play"} size={13} />
                    {task().enabled ? t("schedule.detail.pause") : t("schedule.detail.resume")}
                  </button>
                  <button
                    class="popover-item"
                    role="menuitem"
                    disabled={busy() || task().lastStatus === "running"}
                    onClick={() => void runNow(task())}
                  >
                    <Icon name="play" size={13} />
                    {t("schedule.detail.runNow")}
                  </button>
                  <div class="menu-separator" />
                  <button class="popover-item danger" role="menuitem" disabled={busy()} onClick={() => removeTask(task())}>
                    <Icon name="trash" size={13} />
                    {t("schedule.detail.delete")}
                  </button>
                </div>
              )
            }}
          </Show>
        </div>
      </div>
    </Show>
  )
}
