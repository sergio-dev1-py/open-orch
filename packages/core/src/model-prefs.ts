import path from "node:path"
import type { ModelRef } from "@openorch/shared"
import { ensureDir, readJson, writeJsonAtomic } from "./util.js"

/**
 * Model preferences, mirroring upstream `state/model.json`: recent models,
 * the last model used per directory (project) and the last variant per model.
 */
export interface ModelPreferences {
  recent: ModelRef[]
  byDirectory: Record<string, ModelRef>
  variant: Record<string, string>
}

/** Key for a model, accepting both `ModelRef` (`modelID`) and `ModelInfo` (`id`). */
export function modelKey(ref: { providerID: string; modelID?: string; id?: string }): string {
  return `${ref.providerID}/${ref.modelID ?? ref.id ?? ""}`
}

const MAX_RECENT = 10

export class ModelPreferenceStore {
  private file: string
  private value: ModelPreferences

  constructor(dataDir: string) {
    ensureDir(dataDir)
    this.file = path.join(dataDir, "model.json")
    const saved = readJson<Partial<ModelPreferences>>(this.file, {})
    this.value = {
      recent: saved.recent ?? [],
      byDirectory: saved.byDirectory ?? {},
      variant: saved.variant ?? {},
    }
  }

  get(): ModelPreferences {
    return this.value
  }

  recent(): ModelRef[] {
    return this.value.recent
  }

  forDirectory(directory: string): ModelRef | undefined {
    return this.value.byDirectory[directory]
  }

  variantFor(ref: { providerID: string; modelID?: string; id?: string }): string | undefined {
    return this.value.variant[modelKey(ref)]
  }

  /** Records a model (and variant) as used, per directory and globally. */
  remember(ref: ModelRef, directory?: string): void {
    const entry: ModelRef = { providerID: ref.providerID, modelID: ref.modelID, ...(ref.variant ? { variant: ref.variant } : {}) }
    this.value.recent = [entry, ...this.value.recent.filter((item) => modelKey(item) !== modelKey(entry))].slice(0, MAX_RECENT)
    if (directory) this.value.byDirectory[directory] = entry
    writeJsonAtomic(this.file, this.value)
  }

  setVariant(ref: { providerID: string; modelID?: string; id?: string }, variant?: string): void {
    if (variant && variant !== "default") this.value.variant[modelKey(ref)] = variant
    else delete this.value.variant[modelKey(ref)]
    writeJsonAtomic(this.file, this.value)
  }
}
