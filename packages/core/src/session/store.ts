import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Message, SessionInfo } from "@openorch/shared"
import { ensureDir } from "../util.js"
import type { SqliteDb } from "../storage.js"

export interface SessionRecord {
  info: SessionInfo
  messages: Message[]
}

/**
 * Session persistence. SQLite is the primary driver (single file, WAL, incremental
 * row writes); the JSON-file driver is kept as a fallback for environments where
 * `node:sqlite` is unavailable.
 */
export class SessionStore {
  private cache = new Map<string, SessionRecord>()
  private dirty = new Set<string>()
  private rewrite = new Set<string>()
  private dir: string
  private db: SqliteDb | undefined
  readonly kind: "sqlite" | "json"

  constructor(dataDir: string, db?: SqliteDb) {
    this.dir = path.join(dataDir, "sessions")
    ensureDir(this.dir)
    this.db = db
    this.kind = db ? "sqlite" : "json"
    if (!db) this.migrateSqliteBackup(dataDir)
  }

  /** If a previous run used SQLite but it is unavailable now, keep JSON working. */
  private migrateSqliteBackup(dataDir: string): void {
    const target = `${this.dir}.migrated`
    if (existsSync(target)) {
      try {
        renameSync(target, this.dir)
      } catch {
        // ignore
      }
    }
    void dataDir
  }

  private filePath(sessionID: string): string {
    return path.join(this.dir, `${sessionID}.json`)
  }

  list(): SessionInfo[] {
    if (this.db) {
      const rows = this.db
        .prepare("SELECT id, title, directory, agent, model, parent_id, cost, tokens, time_created, time_updated FROM session ORDER BY time_updated DESC")
        .all() as Record<string, unknown>[]
      return rows.map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ""),
        directory: String(row.directory ?? ""),
        agent: String(row.agent ?? "build"),
        model: row.model ? (JSON.parse(String(row.model)) as SessionInfo["model"]) : undefined,
        parentID: row.parent_id ? String(row.parent_id) : undefined,
        cost: row.cost === null || row.cost === undefined ? undefined : Number(row.cost),
        tokens: row.tokens ? (JSON.parse(String(row.tokens)) as SessionInfo["tokens"]) : undefined,
        time: { created: Number(row.time_created), updated: Number(row.time_updated) },
      }))
    }
    const out: SessionInfo[] = []
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue
      try {
        const record = JSON.parse(readFileSync(path.join(this.dir, entry), "utf8")) as SessionRecord
        if (record?.info?.id) out.push(record.info)
      } catch {
        continue
      }
    }
    return out.sort((a, b) => b.time.updated - a.time.updated)
  }

  get(sessionID: string): SessionRecord | undefined {
    const cached = this.cache.get(sessionID)
    if (cached) return cached
    const record = this.db ? this.loadSqlite(sessionID) : this.loadJson(sessionID)
    if (record) this.cache.set(sessionID, record)
    return record
  }

  private loadSqlite(sessionID: string): SessionRecord | undefined {
    if (!this.db) return undefined
    const row = this.db
      .prepare("SELECT id, title, directory, agent, model, parent_id, cost, tokens, time_created, time_updated FROM session WHERE id = ?")
      .get(sessionID) as Record<string, unknown> | undefined
    if (!row) return undefined
    const messages = (this.db.prepare("SELECT data FROM message WHERE session_id = ? ORDER BY seq ASC").all(sessionID) as { data: string }[]).map(
      (entry) => JSON.parse(entry.data) as Message,
    )
    return {
      info: {
        id: String(row.id),
        title: String(row.title ?? ""),
        directory: String(row.directory ?? ""),
        agent: String(row.agent ?? "build"),
        model: row.model ? (JSON.parse(String(row.model)) as SessionInfo["model"]) : undefined,
        parentID: row.parent_id ? String(row.parent_id) : undefined,
        cost: row.cost === null || row.cost === undefined ? undefined : Number(row.cost),
        tokens: row.tokens ? (JSON.parse(String(row.tokens)) as SessionInfo["tokens"]) : undefined,
        time: { created: Number(row.time_created), updated: Number(row.time_updated) },
      },
      messages,
    }
  }

  private loadJson(sessionID: string): SessionRecord | undefined {
    const file = this.filePath(sessionID)
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, "utf8")) as SessionRecord
    } catch {
      return undefined
    }
  }

  put(record: SessionRecord): void {
    this.cache.set(record.info.id, record)
  }

  /** Drops a finished session from memory; it reloads from SQLite on demand. */
  release(sessionID: string): void {
    this.cache.delete(sessionID)
  }

  /** Adds a message to the session and persists the row immediately. */
  append(sessionID: string, message: Message): void {
    const record = this.cache.get(sessionID)
    if (!record) return
    record.messages.push(message)
    if (this.db) {
      const seq = record.messages.length - 1
      this.db
        .prepare("INSERT OR REPLACE INTO message (id, session_id, seq, role, data, time_created) VALUES (?, ?, ?, ?, ?, ?)")
        .run(message.id, sessionID, seq, message.role, JSON.stringify(message), message.time?.created ?? Date.now())
      this.dirty.delete(message.id)
    }
  }

  /** Marks a mutated message so the next flush writes its row. */
  touch(_sessionID: string, messageID: string): void {
    if (this.db) this.dirty.add(messageID)
  }

  /** Removes a message row (compaction rewrites the whole list instead). */
  removeMessage(_sessionID: string, messageID: string): void {
    if (this.db) this.db.prepare("DELETE FROM message WHERE id = ?").run(messageID)
    this.dirty.delete(messageID)
  }

  /** Marks the session as needing a full message rewrite (compaction). */
  markRewrite(sessionID: string): void {
    this.rewrite.add(sessionID)
  }

  save(sessionID: string): void {
    const record = this.cache.get(sessionID)
    if (!record) return
    if (!this.db) {
      const file = this.filePath(sessionID)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(record, null, 2))
      try {
        renameSync(tmp, file)
      } catch {
        writeFileSync(file, JSON.stringify(record, null, 2))
      }
      return
    }
    const { info } = record
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session (id, title, directory, agent, model, parent_id, cost, tokens, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.id,
        info.title ?? "",
        info.directory ?? "",
        info.agent ?? "build",
        info.model ? JSON.stringify(info.model) : null,
        info.parentID ?? null,
        info.cost ?? null,
        info.tokens ? JSON.stringify(info.tokens) : null,
        info.time.created,
        info.time.updated,
      )
    if (this.rewrite.has(sessionID)) {
      this.rewrite.delete(sessionID)
      this.db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionID)
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO message (id, session_id, seq, role, data, time_created) VALUES (?, ?, ?, ?, ?, ?)",
      )
      record.messages.forEach((message, seq) => {
        insert.run(message.id, sessionID, seq, message.role, JSON.stringify(message), message.time?.created ?? Date.now())
      })
      this.dirty.clear()
      return
    }
    if (this.dirty.size === 0) return
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO message (id, session_id, seq, role, data, time_created) VALUES (?, ?, ?, ?, ?, ?)",
    )
    record.messages.forEach((message, seq) => {
      if (!this.dirty.has(message.id)) return
      insert.run(message.id, sessionID, seq, message.role, JSON.stringify(message), message.time?.created ?? Date.now())
      this.dirty.delete(message.id)
    })
  }

  remove(sessionID: string): void {
    this.cache.delete(sessionID)
    if (this.db) {
      this.db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionID)
      this.db.prepare("DELETE FROM session WHERE id = ?").run(sessionID)
      return
    }
    rmSync(this.filePath(sessionID), { force: true })
  }
}
