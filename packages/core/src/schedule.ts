import { existsSync, statSync } from "node:fs"
import path from "node:path"
import type {
  Config,
  EngineEvent,
  Message,
  ModelRef,
  ScheduledRun,
  ScheduledTask,
  ScheduleClarifyInput,
  ScheduleClarifyResult,
  ScheduleDraft,
  ScheduleRepeat,
  ScheduleTaskView,
  SessionInfo,
} from "@openorch/shared"
import type { SqliteDb } from "./storage.js"
import { id, readJson, writeJsonAtomic } from "./util.js"

/**
 * Local scheduled tasks.
 *
 * Tasks are persisted in the same SQLite database as sessions (JSON payloads),
 * with a JSON file fallback. A single timer checks for due tasks; runs execute
 * one at a time, in the selected workspace, with the selected model/variant.
 * Notifications/tray live in the desktop main process, which listens to the
 * `schedule.run` / `schedule.updated` engine events.
 */

const TICK_MS = 30_000
const WAIT_BUSY_MS = 15 * 60_000
const RUN_TIMEOUT_MS = 2 * 60 * 60_000
const MISSED_GRACE_MS = 24 * 60 * 60_000
const MAX_RUNS = 50

export interface ScheduleManagerDeps {
  dataDir: string
  db?: SqliteDb
  emit: (event: EngineEvent) => void
  log: (message: string) => void
  config: () => Config
  createSession: (input: { directory?: string; agent?: string; model?: ModelRef }) => SessionInfo
  renameSession: (sessionID: string, title: string) => void
  setSessionModel: (sessionID: string, ref: ModelRef) => void
  prompt: (sessionID: string, input: { text: string; delivery?: "steer" | "queue" }) => void
  isBusy: (sessionID: string) => boolean
  waitIdle: (sessionID: string) => Promise<void>
  interrupt: (sessionID: string) => void
  messages: (sessionID: string) => Message[]
  sessionExists: (sessionID: string) => boolean
  defaultModel: (directory: string) => ModelRef | undefined
  setScheduled: (sessionID: string, scheduled: boolean) => void
  /** Lets the engine drop a finished scheduled session from its in-memory cache. */
  releaseSession?: (sessionID: string) => void
  clarify: (input: ScheduleClarifyInput) => Promise<ScheduleClarifyResult>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The scheduler always follows the operating system's current time zone. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export class ScheduleStore {
  private file: string
  private json: { tasks: ScheduledTask[]; runs: ScheduledRun[] } | undefined

  constructor(
    private dataDir: string,
    private db?: SqliteDb,
  ) {
    this.file = path.join(dataDir, "schedules.json")
  }

  allTasks(): ScheduledTask[] {
    if (this.db) {
      try {
        return (this.db.prepare("SELECT data FROM schedule_task").all() as { data: string }[])
          .map((row) => this.parse<ScheduledTask>(row.data))
          .filter((task): task is ScheduledTask => Boolean(task))
      } catch {
        return []
      }
    }
    return this.jsonData().tasks
  }

  getTask(taskID: string): ScheduledTask | undefined {
    if (this.db) {
      try {
        const row = this.db.prepare("SELECT data FROM schedule_task WHERE id = ?").get(taskID) as { data?: string } | undefined
        return row?.data ? this.parse<ScheduledTask>(row.data) : undefined
      } catch {
        return undefined
      }
    }
    return this.jsonData().tasks.find((task) => task.id === taskID)
  }

  putTask(task: ScheduledTask): void {
    if (this.db) {
      this.db
        .prepare("INSERT INTO schedule_task (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .run(task.id, JSON.stringify(task))
      return
    }
    const data = this.jsonData()
    data.tasks = [...data.tasks.filter((entry) => entry.id !== task.id), task]
    this.saveJson(data)
  }

  deleteTask(taskID: string): void {
    if (this.db) {
      this.db.prepare("DELETE FROM schedule_task WHERE id = ?").run(taskID)
      this.db.prepare("DELETE FROM schedule_run WHERE task_id = ?").run(taskID)
      return
    }
    const data = this.jsonData()
    data.tasks = data.tasks.filter((task) => task.id !== taskID)
    data.runs = data.runs.filter((run) => run.taskID !== taskID)
    this.saveJson(data)
  }

  runs(taskID: string, limit = MAX_RUNS): ScheduledRun[] {
    if (this.db) {
      try {
        return (
          this.db
            .prepare("SELECT data FROM schedule_run WHERE task_id = ? ORDER BY time_created DESC LIMIT ?")
            .all(taskID, limit) as { data: string }[]
        )
          .map((row) => this.parse<ScheduledRun>(row.data))
          .filter((run): run is ScheduledRun => Boolean(run))
      } catch {
        return []
      }
    }
    return this.jsonData()
      .runs.filter((run) => run.taskID === taskID)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit)
  }

  putRun(run: ScheduledRun): void {
    if (this.db) {
      this.db
        .prepare(
          "INSERT INTO schedule_run (id, task_id, data, time_created) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        )
        .run(run.id, run.taskID, JSON.stringify(run), run.startedAt)
      // Keep the history bounded per task.
      this.db
        .prepare(
          "DELETE FROM schedule_run WHERE task_id = ? AND id NOT IN " +
            "(SELECT id FROM schedule_run WHERE task_id = ? ORDER BY time_created DESC LIMIT ?)",
        )
        .run(run.taskID, run.taskID, MAX_RUNS)
      return
    }
    const data = this.jsonData()
    data.runs = [run, ...data.runs.filter((entry) => entry.id !== run.id)]
    const own = data.runs.filter((entry) => entry.taskID === run.taskID).slice(0, MAX_RUNS)
    data.runs = [...own, ...data.runs.filter((entry) => entry.taskID !== run.taskID)]
    this.saveJson(data)
  }

  private jsonData(): { tasks: ScheduledTask[]; runs: ScheduledRun[] } {
    if (!this.json) {
      const data = readJson<{ tasks?: ScheduledTask[]; runs?: ScheduledRun[] }>(this.file, {})
      this.json = { tasks: Array.isArray(data.tasks) ? data.tasks : [], runs: Array.isArray(data.runs) ? data.runs : [] }
    }
    return this.json
  }

  private saveJson(data: { tasks: ScheduledTask[]; runs: ScheduledRun[] }): void {
    this.json = data
    writeJsonAtomic(this.file, data)
  }

  private parse<T>(value: string): T | undefined {
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Next occurrence
// ---------------------------------------------------------------------------

function zoneParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") }
}

/** Converts a wall-clock time in `timeZone` to the corresponding UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0)
  let guess = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = zoneParts(new Date(guess), timeZone)
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const difference = target - represented
    if (difference === 0) break
    guess += difference
  }
  return new Date(guess)
}

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return { hour: 9, minute: 0 }
  return { hour: Math.min(23, Math.max(0, Number(match[1]))), minute: Math.min(59, Math.max(0, Number(match[2]))) }
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Next instant strictly after `after` for a task's repeat/time/timeZone.
 * Returns `undefined` for one-time tasks in the past or exhausted schedules.
 */
export function nextOccurrence(task: Pick<ScheduledTask, "repeat" | "time" | "timeZone">, after = Date.now()): number | undefined {
  const repeat = task.repeat
  const zone = task.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
  if (repeat.kind === "once") return repeat.at > after ? repeat.at : undefined

  const { hour, minute } = parseTime(task.time)
  const start = new Date(after)

  if (repeat.kind === "hourly") {
    const interval = Math.min(23, Math.max(1, repeat.interval || 1))
    const firstMinute = Math.ceil((after + 1) / 60_000) * 60_000
    for (let at = firstMinute; at <= after + 8 * 86_400_000; at += 60_000) {
      const candidate = new Date(at)
      const parts = zoneParts(candidate, zone)
      if (parts.minute === 0 && parts.second === 0 && parts.hour % interval === 0) return candidate.getTime()
    }
    return undefined
  }

  const days = repeat.kind === "monthly" ? 400 : repeat.kind === "weekly" ? 14 : 8
  const local = zoneParts(start, zone)
  for (let offset = 0; offset <= days; offset++) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const weekday = weekdayOf(year, month, day)
    let allowed = true
    if (repeat.kind === "weekdays") allowed = weekday >= 1 && weekday <= 5
    else if (repeat.kind === "weekly") allowed = repeat.days.includes(weekday)
    else if (repeat.kind === "monthly") allowed = repeat.day === day
    if (!allowed) continue
    const candidate = zonedTimeToUtc(year, month, day, hour, minute, zone)
    if (candidate.getTime() > after) return candidate.getTime()
  }
  return undefined
}

export function formatNextRun(task: Pick<ScheduledTask, "repeat" | "time" | "timeZone" | "nextRunAt" | "enabled">, now = Date.now()): string {
  if (!task.nextRunAt) return task.enabled === false ? "Pausada" : "No programada"
  const zone = task.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const formatter = new Intl.DateTimeFormat("es", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  const dateFormatter = new Intl.DateTimeFormat("es", { timeZone: zone, weekday: "short", day: "numeric", month: "short" })
  const target = new Date(task.nextRunAt)
  const deltaDays = Math.floor((task.nextRunAt - now) / 86_400_000)
  const when = deltaDays === 0 ? "Hoy" : deltaDays === 1 ? "Mañana" : dateFormatter.format(target)
  return `${when} ${formatter.format(target)}`
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface QueueEntry {
  taskID: string
  trigger: "schedule" | "manual"
}

export class ScheduleManager {
  readonly store: ScheduleStore
  private timer?: NodeJS.Timeout
  private queue: QueueEntry[] = []
  private running = false
  private tickBusy = false
  private activeRuns = new Map<string, { taskID: string; runID: string }>()
  /** Tasks deleted while a run is still unwinding; prevents the task from being saved again. */
  private cancelledTasks = new Set<string>()

  constructor(private deps: ScheduleManagerDeps) {
    this.store = new ScheduleStore(deps.dataDir, deps.db)
  }

  start(): void {
    if (this.timer) return
    this.reconcile()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    setTimeout(() => this.tick(), 1_500).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.queue = []
  }

  list(): ScheduledTask[] {
    return this.store
      .allTasks()
      .sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
        return (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER)
      })
  }

  view(taskID: string): ScheduleTaskView | undefined {
    const task = this.store.getTask(taskID)
    return task ? { task, runs: this.store.runs(taskID) } : undefined
  }

  runs(taskID: string): ScheduledRun[] {
    return this.store.runs(taskID)
  }

  async create(draft: ScheduleDraft): Promise<ScheduledTask> {
    const now = Date.now()
    const task: ScheduledTask = {
      id: id("sch"),
      title: (draft.title || draft.instruction.split("\n")[0] || "Tarea programada").trim().slice(0, 120),
      instruction: draft.instruction.trim(),
      originalInstruction: draft.originalInstruction,
      repeat: draft.repeat,
      time: draft.time,
      timeZone: systemTimeZone(),
      workspace: path.resolve(draft.workspace),
      model: draft.model,
      notify: draft.notify,
      background: draft.background,
      newChatEachRun: draft.newChatEachRun,
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    this.validate(task)
    task.nextRunAt = task.enabled ? nextOccurrence(task, now) : undefined
    this.store.putTask(task)
    this.deps.emit({ type: "schedule.updated", task })
    return task
  }

  update(taskID: string, patch: Partial<ScheduleDraft> & { enabled?: boolean }): ScheduledTask {
    const current = this.store.getTask(taskID)
    if (!current) throw new Error("La tarea programada ya no existe.")
    const next: ScheduledTask = {
      ...current,
      ...patch,
      title: patch.title !== undefined ? patch.title.trim().slice(0, 120) : current.title,
      instruction: patch.instruction !== undefined ? patch.instruction.trim() : current.instruction,
      workspace: patch.workspace !== undefined ? path.resolve(patch.workspace) : current.workspace,
      timeZone: systemTimeZone(),
      enabled: patch.enabled ?? current.enabled,
      updatedAt: Date.now(),
    }
    if (!next.instruction) throw new Error("La tarea necesita instrucciones.")
    this.validate(next)
    const scheduleChanged =
      patch.repeat !== undefined ||
      patch.time !== undefined ||
      patch.timeZone !== undefined ||
      patch.enabled !== undefined ||
      patch.workspace !== undefined
    if (scheduleChanged) next.nextRunAt = next.enabled ? nextOccurrence(next, Date.now()) : undefined
    this.store.putTask(next)
    this.deps.emit({ type: "schedule.updated", task: next })
    return next
  }

  remove(taskID: string): void {
    this.cancelledTasks.add(taskID)
    this.queue = this.queue.filter((entry) => entry.taskID !== taskID)
    let active = false
    for (const [sessionID, run] of this.activeRuns) {
      if (run.taskID !== taskID) continue
      active = true
      if (this.deps.isBusy(sessionID)) this.deps.interrupt(sessionID)
    }
    // Only a live execute() needs the tombstone; it clears it in its finally.
    if (!active) this.cancelledTasks.delete(taskID)
    this.store.deleteTask(taskID)
    this.deps.emit({ type: "schedule.deleted", taskID })
  }

  setEnabled(taskID: string, enabled: boolean): ScheduledTask {
    const next = this.update(taskID, { enabled })
    if (!enabled && next.background) {
      // Pausing the last background task also turns off "Run on this computer".
      const otherBackground = this.store.allTasks().some((task) => task.id !== taskID && task.enabled && task.background)
      if (!otherBackground) return this.update(taskID, { background: false })
    }
    return next
  }

  runNow(taskID: string): void {
    const task = this.store.getTask(taskID)
    if (!task) throw new Error("La tarea programada ya no existe.")
    if (!task.workspace || !existsSync(task.workspace)) throw new Error("La carpeta de trabajo no existe.")
    if (this.queue.some((entry) => entry.taskID === taskID) || this.activeRunsHasTask(taskID)) {
      throw new Error("La tarea ya se está ejecutando.")
    }
    this.queue.push({ taskID, trigger: "manual" })
    this.tick()
  }

  clarify(input: ScheduleClarifyInput): Promise<ScheduleClarifyResult> {
    return this.deps.clarify(input)
  }

  taskForSession(sessionID: string): ScheduledTask | undefined {
    const active = this.activeRuns.get(sessionID)
    return active ? this.store.getTask(active.taskID) : undefined
  }

  private activeRunsHasTask(taskID: string): boolean {
    for (const entry of this.activeRuns.values()) if (entry.taskID === taskID) return true
    return false
  }

  /** Tasks follow the OS time zone even if it changes while OpenOrch is running. */
  private syncTimeZones(): void {
    const zone = systemTimeZone()
    const now = Date.now()
    for (const task of this.store.allTasks()) {
      if (task.timeZone === zone) continue
      task.timeZone = zone
      task.nextRunAt = task.enabled ? nextOccurrence(task, now) : undefined
      task.updatedAt = now
      this.store.putTask(task)
      this.deps.emit({ type: "schedule.updated", task })
    }
  }

  private validate(task: ScheduledTask): void {
    if (!task.instruction.trim()) throw new Error("La tarea necesita instrucciones.")
    if (!existsSync(task.workspace) || !statSync(task.workspace).isDirectory()) {
      throw new Error("La carpeta de trabajo no existe.")
    }
    if (task.repeat.kind === "weekly" && task.repeat.days.length === 0) {
      throw new Error("Elige al menos un día de la semana.")
    }
    if (task.repeat.kind === "monthly" && (task.repeat.day < 1 || task.repeat.day > 31)) {
      throw new Error("El día del mes debe estar entre 1 y 31.")
    }
    if (task.repeat.kind === "hourly" && (task.repeat.interval < 1 || task.repeat.interval > 23)) {
      throw new Error("El intervalo debe estar entre 1 y 23 horas.")
    }
    if (task.repeat.kind === "once" && task.repeat.at <= Date.now()) {
      throw new Error("La fecha de la tarea ya pasó.")
    }
  }

  private reconcile(): void {
    this.syncTimeZones()
    const now = Date.now()
    const tasks = this.store.allTasks()
    // If nothing can run in the background, keep the per-task preference
    // consistent with the automatically disabled tray/login-item mode.
    const hasBackgroundTask = tasks.some((task) => task.enabled && task.background)
    for (const task of tasks) {
      let changed = false
      if (!hasBackgroundTask && task.background) {
        task.background = false
        changed = true
      }
      if (task.lastStatus === "running") {
        task.lastStatus = "interrupted"
        task.lastError = "La ejecución se interrumpió porque OpenOrch se cerró."
        task.updatedAt = now
        changed = true
      }
      if (!task.enabled) {
        if (task.nextRunAt !== undefined) {
          task.nextRunAt = undefined
          changed = true
        }
      } else if (task.nextRunAt === undefined) {
        task.nextRunAt = nextOccurrence(task, now)
        changed = true
      } else if (task.nextRunAt <= now) {
        if (now - task.nextRunAt <= MISSED_GRACE_MS) {
          this.queue.push({ taskID: task.id, trigger: "schedule" })
          changed = true
        } else {
          task.nextRunAt = nextOccurrence(task, now)
          changed = true
        }
      }
      if (changed) this.store.putTask(task)
    }
  }

  private tick(): void {
    if (this.tickBusy || this.running) return
    this.tickBusy = true
    try {
      this.syncTimeZones()
      if (this.queue.length === 0) {
        const now = Date.now()
        const due = this.store
          .allTasks()
          .filter((task) => task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now)
          .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))
        for (const task of due) {
          if (this.queue.some((entry) => entry.taskID === task.id) || this.activeRunsHasTask(task.id)) continue
          this.queue.push({ taskID: task.id, trigger: "schedule" })
          break
        }
      }
      const next = this.queue.shift()
      if (!next) return
      if (this.activeRunsHasTask(next.taskID)) return
      void this.execute(next)
    } catch (error) {
      // A bad task/DB row must never take the whole scheduler down.
      this.deps.log(`schedule: tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.tickBusy = false
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    if (this.running) {
      this.queue.unshift(entry)
      return
    }
    this.running = true
    let sessionID = ""
    let run: ScheduledRun | undefined
    try {
      if (this.cancelledTasks.has(entry.taskID)) return
      const task = this.store.getTask(entry.taskID)
      if (!task) return
      task.timeZone = systemTimeZone()
      if (entry.trigger === "schedule" && !task.enabled) return
      if (!existsSync(task.workspace) || !statSync(task.workspace).isDirectory()) {
        throw new Error(`La carpeta de trabajo no existe: ${task.workspace}`)
      }

      const reuse = !task.newChatEachRun && task.sessionID && this.deps.sessionExists(task.sessionID)
      if (reuse) {
        sessionID = task.sessionID!
        if (this.deps.isBusy(sessionID)) {
          const deadline = Date.now() + WAIT_BUSY_MS
          while (this.deps.isBusy(sessionID) && Date.now() < deadline) await sleep(500)
          if (this.deps.isBusy(sessionID)) throw new Error("La sesión de la tarea está ocupada; se omitió esta ejecución.")
        }
      } else {
        const session = this.deps.createSession({ directory: task.workspace, agent: "build", model: task.model })
        sessionID = session.id
        this.deps.renameSession(sessionID, task.title)
      }
      if (task.model) this.deps.setSessionModel(sessionID, task.model)

      const startedAt = Date.now()
      run = {
        id: id("run"),
        taskID: task.id,
        taskTitle: task.title,
        sessionID,
        status: "running",
        trigger: entry.trigger,
        startedAt,
      }
      this.store.putRun(run)
      this.activeRuns.set(sessionID, { taskID: task.id, runID: run.id })
      task.lastStatus = "running"
      task.lastRunAt = startedAt
      task.lastError = undefined
      task.updatedAt = startedAt
      this.store.putTask(task)
      this.deps.emit({ type: "schedule.updated", task })

      this.deps.setScheduled(sessionID, true)
      this.deps.prompt(sessionID, { text: task.instruction, delivery: "queue" })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.deps.waitIdle(sessionID),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("La tarea superó el tiempo máximo de ejecución (2 horas).")), RUN_TIMEOUT_MS)
            timeout.unref?.()
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }

      // A delete can arrive while the model is running. Interrupting the chat is
      // best-effort, so always re-check before writing the task back.
      if (this.cancelledTasks.has(task.id) || !this.store.getTask(task.id)) return

      const messages = this.deps.messages(sessionID)
      const assistants = messages.filter((message) => message.role === "assistant")
      const last = assistants.at(-1)
      const summary = last
        ? last.content
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim()
            .slice(0, 8_000)
        : ""
      const failed = Boolean(last?.error) || messages.some((message) => message.role === "assistant" && message.error)
      const finishedAt = Date.now()
      run = {
        ...run,
        status: failed ? "failed" : "success",
        finishedAt,
        summary: summary || undefined,
        error: last?.error,
      }
      this.store.putRun(run)

      task.sessionID = sessionID
      task.lastRunAt = finishedAt
      task.lastStatus = failed ? "failed" : "success"
      task.lastSummary = summary || undefined
      task.lastError = last?.error
      task.updatedAt = finishedAt
      if (entry.trigger === "schedule") {
        if (task.repeat.kind === "once") {
          task.enabled = false
          task.nextRunAt = undefined
        } else {
          task.nextRunAt = nextOccurrence(task, finishedAt)
        }
      } else if (task.repeat.kind === "once") {
        task.enabled = false
        task.nextRunAt = undefined
      } else if (task.nextRunAt === undefined || task.nextRunAt <= finishedAt) {
        task.nextRunAt = nextOccurrence(task, finishedAt)
      }
      this.store.putTask(task)
      this.deps.emit({ type: "schedule.updated", task })
      this.deps.emit({ type: "schedule.run", run, task })
    } catch (error) {
      if (this.cancelledTasks.has(entry.taskID)) return
      const message = error instanceof Error ? error.message : String(error)
      const task = this.store.getTask(entry.taskID)
      if (sessionID && this.deps.isBusy(sessionID)) this.deps.interrupt(sessionID)
      if (!run && task) {
        run = {
          id: id("run"),
          taskID: task.id,
          taskTitle: task.title,
          sessionID: task.sessionID ?? "",
          status: "failed",
          trigger: entry.trigger,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          error: message,
        }
        this.store.putRun(run)
      }
      if (run) {
        run = { ...run, status: "failed", finishedAt: Date.now(), error: message }
        this.store.putRun(run)
      }
      if (task) {
        task.lastStatus = "failed"
        task.lastError = message
        task.lastRunAt = Date.now()
        task.updatedAt = Date.now()
        if (task.repeat.kind === "once" && entry.trigger === "schedule") {
          task.enabled = false
          task.nextRunAt = undefined
        } else if (entry.trigger === "schedule") {
          task.nextRunAt = nextOccurrence(task, Date.now())
        }
        this.store.putTask(task)
        this.deps.emit({ type: "schedule.updated", task })
        if (run) this.deps.emit({ type: "schedule.run", run, task })
      }
      this.deps.log(`schedule: ${entry.taskID} failed: ${message}`)
    } finally {
      if (sessionID) {
        this.deps.setScheduled(sessionID, false)
        this.deps.releaseSession?.(sessionID)
      }
      if (run?.sessionID) this.activeRuns.delete(run.sessionID)
      this.cancelledTasks.delete(entry.taskID)
      this.running = false
      this.tick()
    }
  }
}
