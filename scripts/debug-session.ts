/** Dumps the tail of the e2e parent session for debugging. */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import path from "node:path"

const databasePath = process.argv[2] ?? path.join(import.meta.dir, "../.data/e2e/userdata/openorch.db")
if (!existsSync(databasePath)) {
  console.error(`Session database not found: ${databasePath}`)
  console.error("Run the e2e suite first, or pass the database path explicitly.")
  process.exit(1)
}
const db = new Database(databasePath, { readonly: true })
const session = db
  .query("SELECT id, title FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1")
  .get() as { id: string; title: string }
console.log("session:", session.id, session.title)
const rows = db
  .query("SELECT role, data FROM message WHERE session_id = ? ORDER BY seq DESC LIMIT 8")
  .all(session.id) as { role: string; data: string }[]
for (const row of rows.reverse()) {
  const message = JSON.parse(row.data) as { role: string; text?: string; content?: { type: string; tool?: string; state?: { status?: string; error?: string; input?: unknown } }[] }
  if (message.text) {
    console.log(`- ${message.role}: ${message.text.replaceAll(/\s+/g, " ").slice(0, 90)}`)
    continue
  }
  const parts = (message.content ?? [])
    .map((part) => {
      if (part.type !== "tool") return part.type
      const state = part.state as { status?: string; error?: string; input?: unknown; content?: { type: string; text?: string }[]; metadata?: Record<string, unknown> }
      const text = (state.content ?? []).map((item) => (item.type === "text" ? (item.text ?? "").slice(0, 220) : `[${item.type}]`)).join(" ")
      return `tool(${part.tool})=${state.status} ${(state.error ?? "").slice(0, 60)} in=${JSON.stringify(state.input ?? {}).slice(0, 90)} out=${text.replaceAll("\n", " ⏎ ")} meta=${JSON.stringify(state.metadata ?? {}).slice(0, 90)}`
    })
    .join(" | ")
  console.log(`- ${message.role}: ${parts}`)
}
db.close()
