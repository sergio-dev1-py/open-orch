/**
 * Scheduled task date/store checks (no Electron).
 *
 *   bun run scripts/check-schedule.ts
 */
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { ScheduleManager, ScheduleStore, nextOccurrence, zonedTimeToUtc } from "../packages/core/src/schedule"

const root = path.resolve(import.meta.dir, "..")
const dataDir = path.join(root, ".data", "schedule-check")
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

const iso = (value: number | undefined) => (value === undefined ? "none" : new Date(value).toISOString())

// Bogota is UTC-5 (no DST).
const bogotaMorning = zonedTimeToUtc(2026, 10, 21, 9, 0, "America/Bogota")
check("schedule: zoned time converts to UTC", bogotaMorning.toISOString() === "2026-10-21T14:00:00.000Z", bogotaMorning.toISOString())

const daily = nextOccurrence(
  { repeat: { kind: "daily" }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 20, 15, 0), // 2026-10-20 10:00 in Bogota
)
check("schedule: daily moves to tomorrow 09:00", iso(daily) === "2026-10-21T14:00:00.000Z", iso(daily))

const weekdays = nextOccurrence(
  { repeat: { kind: "weekdays" }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 23, 15, 0), // Friday 10:00
)
check("schedule: weekdays skip the weekend", iso(weekdays) === "2026-10-26T14:00:00.000Z", iso(weekdays))

const weekly = nextOccurrence(
  { repeat: { kind: "weekly", days: [1] }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 20, 15, 0), // Tuesday
)
check("schedule: weekly lands on the selected weekday", iso(weekly) === "2026-10-26T14:00:00.000Z", iso(weekly))

const monthly = nextOccurrence(
  { repeat: { kind: "monthly", day: 1 }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 20, 15, 0),
)
check("schedule: monthly moves to the next month", iso(monthly) === "2026-11-01T14:00:00.000Z", iso(monthly))

const hourly = nextOccurrence(
  { repeat: { kind: "hourly", interval: 2 }, time: "00:00", timeZone: "UTC" },
  Date.UTC(2026, 9, 20, 10, 5),
)
check("schedule: hourly respects the interval", iso(hourly) === "2026-10-20T12:00:00.000Z", iso(hourly))

const once = nextOccurrence(
  { repeat: { kind: "once", at: Date.UTC(2026, 9, 21, 14, 0) }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 20, 15, 0),
)
check("schedule: one-time tasks return their instant", iso(once) === "2026-10-21T14:00:00.000Z", iso(once))

const pastOnce = nextOccurrence(
  { repeat: { kind: "once", at: Date.UTC(2026, 9, 19, 14, 0) }, time: "09:00", timeZone: "America/Bogota" },
  Date.UTC(2026, 9, 20, 15, 0),
)
check("schedule: past one-time tasks do not repeat", pastOnce === undefined)

// JSON fallback store (no SQLite handle) with a round-trip.
const store = new ScheduleStore(dataDir)
const task = {
  id: "sch_test",
  title: "Test",
  instruction: "Haz algo",
  repeat: { kind: "daily" as const },
  time: "09:00",
  timeZone: "America/Bogota",
  workspace: dataDir,
  notify: true,
  background: true,
  newChatEachRun: true,
  enabled: true,
  nextRunAt: Date.UTC(2026, 9, 21, 14, 0),
  createdAt: 1,
  updatedAt: 1,
}
store.putTask(task)
check("schedule store: task round-trips", store.getTask(task.id)?.title === "Test")
store.putRun({
  id: "run_test",
  taskID: task.id,
  taskTitle: task.title,
  sessionID: "ses_test",
  status: "success",
  trigger: "manual",
  startedAt: 2,
  finishedAt: 3,
  summary: "ok",
})
check("schedule store: run history is read back", store.runs(task.id)[0]?.status === "success")
store.deleteTask(task.id)
check("schedule store: delete removes task and runs", store.getTask(task.id) === undefined && store.runs(task.id).length === 0)

// Deleting a task while it is running must interrupt the chat, remove the
// schedule/run and never write the task back when the run unwinds.
const managerDir = path.join(root, ".data", "schedule-manager-check")
rmSync(managerDir, { recursive: true, force: true })
mkdirSync(managerDir, { recursive: true })
let interrupted = false
let started = false
let finish!: () => void
const finished = new Promise<void>((resolve) => {
  finish = resolve
})
let idleResolve!: () => void
const idle = new Promise<void>((resolve) => {
  idleResolve = resolve
})
const manager = new ScheduleManager({
  dataDir: managerDir,
  emit: () => undefined,
  log: () => undefined,
  config: () => ({}) as never,
  createSession: () =>
    ({
      id: "ses_schedule_delete",
      title: "",
      directory: managerDir,
      agent: "build",
      time: { created: Date.now(), updated: Date.now() },
    }) as never,
  renameSession: () => undefined,
  setSessionModel: () => undefined,
  prompt: () => {
    started = true
  },
  isBusy: () => true,
  waitIdle: () => idle,
  interrupt: () => {
    interrupted = true
    idleResolve()
  },
  messages: () => [],
  sessionExists: () => true,
  defaultModel: () => undefined,
  setScheduled: (_sessionID, scheduled) => {
    if (!scheduled) finish()
  },
  clarify: async () => ({ title: "", clear: true, questions: [], finalInstruction: "" }),
} as never)
const deletingTask = await manager.create({
  title: "Borrar mientras corre",
  instruction: "Espera para siempre",
  repeat: { kind: "daily" },
  time: "09:00",
  workspace: managerDir,
  notify: false,
  background: true,
  newChatEachRun: true,
} as never)
manager.runNow(deletingTask.id)
while (!started) await new Promise((resolve) => setTimeout(resolve, 5))
manager.remove(deletingTask.id)
await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2_000))])
await new Promise((resolve) => setTimeout(resolve, 50))
check(
  "schedule manager: deleting a running task interrupts it and does not resurrect it",
  interrupted &&
    started &&
    manager.store.getTask(deletingTask.id) === undefined &&
    manager.store.runs(deletingTask.id).length === 0 &&
    manager.list().length === 0,
  `interrupted=${interrupted} tasks=${manager.list().length}`,
)
manager.stop()

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} schedule checks passed`)
if (failed.length > 0) process.exitCode = 1
