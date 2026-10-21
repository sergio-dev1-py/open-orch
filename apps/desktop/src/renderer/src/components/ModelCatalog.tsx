import { For, createEffect, createMemo, createSignal, onMount } from "solid-js"
import type { ModelInfo, ProviderInfo } from "@openorch/shared"
import { api } from "../api"
import { state } from "../store"

/**
 * Shared model catalog for selectors outside the composer.
 *
 * The renderer normally receives `state.models` during initial load; when a
 * window is opened before that finishes (or the list is stale) this hook loads
 * the catalog on demand and exposes a refresh action. It never filters by
 * `provider.configured`, so a configured provider can never disappear from a
 * selector just because its flag was momentarily out of date.
 */
export function createModelCatalog() {
  const [models, setModels] = createSignal<ModelInfo[]>(state.models ?? [])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")

  createEffect(() => {
    const current = state.models ?? []
    if (current.length > 0) setModels(current)
  })

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await api.listModels()
      setModels(next)
      setError(next.length === 0 ? "No hay modelos disponibles. Revisa Ajustes → Proveedores." : "")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    if (models().length === 0) void refresh()
  })

  return { models, loading, error, refresh }
}

export interface ModelGroup {
  providerID: string
  name: string
  models: ModelInfo[]
}

export function groupModels(models: ModelInfo[], providers: ProviderInfo[] = state.providers ?? []): ModelGroup[] {
  const groups = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const list = groups.get(model.providerID) ?? []
    list.push(model)
    groups.set(model.providerID, list)
  }
  const providerName = (providerID: string) =>
    providers.find((provider) => provider.id === providerID)?.name ?? providerID
  return [...groups.entries()]
    .map(([providerID, list]) => ({
      providerID,
      name: providerName(providerID),
      models: [...list].sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Native `<optgroup>` options for a model `<select>`. */
export function ModelOptions(props: { models: ModelInfo[] }) {
  const groups = createMemo(() => groupModels(props.models ?? []))
  return (
    <For each={groups()}>
      {(group) => (
        <optgroup label={group.name}>
          <For each={group.models}>
            {(model) => <option value={`${model.providerID}/${model.id}`}>{model.name || model.id}</option>}
          </For>
        </optgroup>
      )}
    </For>
  )
}
