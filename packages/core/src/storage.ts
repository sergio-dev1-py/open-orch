import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { Message, PermissionRule, SessionInfo } from "@openorch/shared"
import { ensureDir } from "./util.js"

/**
 * SQLite-backed storage. Uses the built-in `node:sqlite` module (Node 22.5+/24),
 * which ships inside Electron; no native modules or rebuilds required.
 * When the module is unavailable the engine falls back to the JSON store.
 */

const nodeRequire = createRequire(import.meta.url)

export interface SqliteStatement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'build',
  model TEXT,
  parent_id TEXT,
  cost REAL,
  tokens TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, seq);
CREATE TABLE IF NOT EXISTS permission (
  project TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  PRIMARY KEY (project, action, resource)
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_task (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_run_task ON schedule_run(task_id, time_created);
`

export function openDataDatabase(dataDir: string): SqliteDb | undefined {
  ensureDir(dataDir)
  const file = path.join(dataDir, "openorch.db")
  try {
    const sqlite = nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb }
    const db = new sqlite.DatabaseSync(file)
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA synchronous = NORMAL;")
    db.exec("PRAGMA busy_timeout = 5000;")
    db.exec("PRAGMA foreign_keys = ON;")
    db.exec(SCHEMA)
    migrateFromJson(dataDir, db)
    return db
  } catch (error) {
    console.log(`[storage] sqlite unavailable, using JSON store: ${String(error)}`)
    return undefined
  }
}

interface SerializedSession {
  info: SessionInfo
  messages: Message[]
}

/** One-time import of the JSON sessions/permissions written by earlier versions. */
function migrateFromJson(dataDir: string, db: SqliteDb): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM session").get() as { count?: number } | undefined
  const sessionsDir = path.join(dataDir, "sessions")
  if (Number(count?.count ?? 0) > 0 || !existsSync(sessionsDir)) return

  const files = readdirSync(sessionsDir).filter((entry) => entry.endsWith(".json"))
  if (files.length === 0) return

  let imported = 0
  const insertSession = db.prepare(
    `INSERT OR REPLACE INTO session (id, title, directory, agent, model, parent_id, cost, tokens, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO message (id, session_id, seq, role, data, time_created) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8")) as SerializedSession
      if (!record?.info?.id) continue
      insertSession.run(
        record.info.id,
        record.info.title ?? "",
        record.info.directory ?? "",
        record.info.agent ?? "build",
        record.info.model ? JSON.stringify(record.info.model) : null,
        record.info.parentID ?? null,
        record.info.cost ?? null,
        record.info.tokens ? JSON.stringify(record.info.tokens) : null,
        record.info.time.created,
        record.info.time.updated,
      )
      record.messages?.forEach((message, index) => {
        insertMessage.run(message.id, record.info.id, index, message.role, JSON.stringify(message), message.time?.created ?? Date.now())
      })
      imported++
    } catch {
      continue
    }
  }

  // Saved permission rules from the JSON era.
  const permissionsFile = path.join(dataDir, "permissions.json")
  if (existsSync(permissionsFile)) {
    try {
      const saved = JSON.parse(readFileSync(permissionsFile, "utf8")) as Record<string, PermissionRule[]>
      const insertRule = db.prepare("INSERT OR REPLACE INTO permission (project, action, resource) VALUES (?, ?, ?)")
      for (const [project, rules] of Object.entries(saved)) {
        for (const rule of rules) insertRule.run(project, rule.action, rule.resource)
      }
      renameSync(permissionsFile, `${permissionsFile}.migrated`)
    } catch {
      // ignore
    }
  }

  if (imported > 0) {
    try {
      renameSync(sessionsDir, `${sessionsDir}.migrated`)
    } catch {
      // ignore: the JSON files stay as a backup
    }
    console.log(`[storage] migrated ${imported} JSON sessions into SQLite`)
  }
}

// ---------------------------------------------------------------------------
// Saved permission rules
// ---------------------------------------------------------------------------

export interface SavedPermissionRule extends PermissionRule {
  project?: string
}

export interface SavedPermissionStore {
  all(): SavedPermissionRule[]
  rulesFor(directory: string): PermissionRule[]
  add(directory: string, action: string, resources: string[]): void
  clear(): void
}

export function createSqlitePermissionStore(db: SqliteDb): SavedPermissionStore {
  return {
    all() {
      const rows = db.prepare("SELECT project, action, resource FROM permission").all() as {
        project: string
        action: string
        resource: string
      }[]
      return rows.map((row) => ({ action: row.action, resource: row.resource, effect: "allow" as const, project: row.project }))
    },
    rulesFor(directory: string) {
      const rows = db.prepare("SELECT action, resource FROM permission WHERE project = ?").all(directory) as {
        action: string
        resource: string
      }[]
      return rows.map((row) => ({ action: row.action, resource: row.resource, effect: "allow" as const }))
    },
    add(directory, action, resources) {
      const insert = db.prepare("INSERT OR REPLACE INTO permission (project, action, resource) VALUES (?, ?, ?)")
      for (const resource of resources) insert.run(directory, action, resource)
    },
    clear() {
      db.exec("DELETE FROM permission")
    },
  }
}
