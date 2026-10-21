/**
 * Generates packages/core/src/providers/catalog.json from a models.dev snapshot
 * (e.g. the one bundled with the upstream OpenCode repository, MIT licensed).
 *
 * Usage: bun run scripts/build-catalog.ts [path-to-snapshot.txt]
 *
 * For day-to-day updates prefer scripts/update-catalog.ts, which merges the live
 * models.dev catalog into the existing baseline instead of replacing it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { convertModelsDev, type RawProvider } from "../packages/core/src/providers/models-dev.ts"

const OUT = path.join(import.meta.dir, "../packages/core/src/providers/catalog.json")

const snapshotPath = process.argv[2] ?? process.env.MODELS_DEV_SNAPSHOT
if (!snapshotPath) {
  console.error("Usage: bun run scripts/build-catalog.ts <models.dev-snapshot.json>")
  console.error("       (or set MODELS_DEV_SNAPSHOT to the snapshot path)")
  process.exit(1)
}
const raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, RawProvider>
const providers = convertModelsDev(raw)

const catalog = {
  source: "models.dev snapshot (via opencode, MIT)",
  generatedAt: new Date().toISOString(),
  count: providers.length,
  providers,
}
writeFileSync(OUT, JSON.stringify(catalog))
console.log(`Wrote ${OUT}`)
console.log(`providers: ${providers.length}, models: ${providers.reduce((sum, provider) => sum + provider.models.length, 0)}`)
