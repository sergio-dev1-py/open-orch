import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { SkillDetail, SkillInfo } from "@openorch/shared"
import { api } from "../api"
import { t } from "../i18n"
import { bumpSkillsRevision, requestConfirm, state, toggleSkillDialog } from "../store"
import { Icon } from "./Icons"

const SKILL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** `Nombre de mi Skill` → `nombre-de-mi-skill` (para asignar el id automáticamente). */
function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
}

/** Skills manager (`/skill`, “Administrar Skills” y “Explorar Skills” del menú +). */
export function SkillDialog() {
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const [query, setQuery] = createSignal("")
  const [view, setView] = createSignal<"list" | "create" | "detail">("list")
  const [addOpen, setAddOpen] = createSignal(false)
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [content, setContent] = createSignal("")
  const [idOverride, setIdOverride] = createSignal<string | undefined>()
  const [error, setError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  // Detail view (click a row): tabs for the description and the editable SKILL.md.
  const [selected, setSelected] = createSignal<SkillDetail | undefined>()
  const [tab, setTab] = createSignal<"description" | "content">("description")
  const [editing, setEditing] = createSignal(false)
  const [editDescription, setEditDescription] = createSignal("")
  const [editContent, setEditContent] = createSignal("")

  const sessionID = () => state.activeSessionID ?? ""

  const refresh = () => {
    void api
      .listSkills(sessionID())
      .then(setSkills)
      .catch(() => setSkills([]))
  }

  const startCreate = () => {
    setName("")
    setDescription("")
    setContent("")
    setIdOverride(undefined)
    setError("")
    setAddOpen(false)
    setView("create")
  }

  createEffect(() => {
    if (!state.skillDialogOpen) return
    refresh()
    if (state.skillDialogMode === "create") startCreate()
    else {
      setView("list")
      setAddOpen(false)
      setSelected(undefined)
      setEditing(false)
    }
  })

  /** Auto-generated id: slug of the name, with a `-2`, `-3`… suffix on collisions. */
  const uniqueId = () => {
    const base = idOverride() ?? (slugify(name()) || "skill")
    if (!skills().some((skill) => skill.id === base)) return base
    let counter = 2
    while (skills().some((skill) => skill.id === `${base}-${counter}`)) counter += 1
    return `${base}-${counter}`
  }

  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const filtered = skills().filter(
      (skill) => !needle || skill.id.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
    )
    const order = [
      { origin: "global", label: t("skills.group.global") },
      { origin: "project", label: t("skills.group.project") },
      { origin: "custom", label: t("skills.group.custom") },
    ] as const
    return order
      .map((group) => ({
        label: group.label,
        skills: filtered.filter((skill) => (skill.origin ?? "project") === group.origin),
      }))
      .filter((group) => group.skills.length > 0)
  })

  const originLabel = (origin: SkillInfo["origin"]) =>
    origin === "project" ? t("skills.origin.project") : origin === "custom" ? t("skills.origin.custom") : t("skills.origin.global")

  const close = () => toggleSkillDialog(false)

  const openDetail = async (skill: SkillInfo) => {
    setError("")
    const detail = await api.readSkill(sessionID(), skill.id)
    if (!detail) return
    setSelected(detail)
    setEditDescription(detail.description)
    setEditContent(detail.content)
    setTab("description")
    setEditing(false)
    setView("detail")
  }

  const saveEdits = async () => {
    const detail = selected()
    if (!detail) return
    setError("")
    setSaving(true)
    try {
      await api.saveSkill(sessionID(), { id: detail.id, name: detail.name, description: editDescription(), content: editContent() })
      const refreshed = await api.readSkill(sessionID(), detail.id)
      if (refreshed) {
        setSelected(refreshed)
        setEditDescription(refreshed.description)
        setEditContent(refreshed.content)
      }
      refresh()
      bumpSkillsRevision()
      setEditing(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    setError("")
    if (!name().trim()) {
      setError(t("skills.nameRequired"))
      return
    }
    setSaving(true)
    try {
      await api.installSkill({
        id: uniqueId(),
        name: name().trim(),
        description: description().trim() || undefined,
        content: content(),
      })
      refresh()
      bumpSkillsRevision()
      setView("list")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  const importDraft = async () => {
    setError("")
    const draft = await api.importSkillDraft()
    if (!draft) return
    setIdOverride(SKILL_ID_PATTERN.test(draft.id) ? draft.id : undefined)
    setName(draft.name ?? draft.id)
    setDescription(draft.description ?? "")
    setContent(draft.content)
    setAddOpen(false)
    setView("create")
  }

  const remove = (skill: SkillInfo, backToList = false) => {
    requestConfirm({
      title: t("skills.remove.title"),
      message: `${t("skills.remove.message")}\n\n«${skill.id}»`,
      confirmLabel: t("skills.remove.confirm"),
      danger: true,
      onConfirm: () => {
        void api.removeSkill(skill.id).then(() => {
          refresh()
          bumpSkillsRevision()
          if (backToList) {
            setView("list")
            setSelected(undefined)
          }
        })
      },
    })
  }

  return (
    <Show when={state.skillDialogOpen}>
      <div class="modal-backdrop" onClick={close}>
        <div class="modal skill-manager" onClick={(event) => event.stopPropagation()}>
          <button class="modal-close icon-button" title={t("app.close")} onClick={close}>
            ✕
          </button>

          <Show when={view() === "list"}>
            <div class="skill-manager-header">
              <h2>{t("skills.title")}</h2>
              <input
                class="workspace-search"
                type="text"
                placeholder={t("skills.search")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <div class="skill-add">
                <button class="button primary" onClick={() => setAddOpen(!addOpen())}>
                  <Icon name="plus" size={13} /> {t("skills.add")} ▾
                </button>
                <Show when={addOpen()}>
                  <div class="skill-add-menu">
                    <button class="popover-item" onClick={startCreate}>
                      <Icon name="plus" size={13} />
                      <span class="name">{t("skills.create")}</span>
                    </button>
                    <button class="popover-item" onClick={() => void importDraft()}>
                      <Icon name="folder-open" size={13} />
                      <span class="name">{t("skills.import")}</span>
                    </button>
                  </div>
                </Show>
              </div>
            </div>
            <div class="skill-manager-list">
              <Show when={groups().length > 0} fallback={<div class="hint">{t("skills.none")}</div>}>
                <For each={groups()}>
                  {(group) => (
                    <>
                      <div class="section-label">{group.label}</div>
                      <For each={group.skills}>
                        {(skill) => (
                          <div class="skill-row" onClick={() => void openDetail(skill)}>
                            <span class="skill-file-icon">
                              <Icon name="file" size={14} />
                            </span>
                            <div class="skill-main">
                              <span class="skill-id">{skill.id}</span>
                              <span class="skill-description">{skill.description || "—"}</span>
                            </div>
                            <Show when={skill.origin === "global"}>
                              <button
                                class="icon-button"
                                title={t("skills.remove.confirm")}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  remove(skill)
                                }}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </Show>
                            <span class="skill-chevron">
                              <Icon name="chevron-right" size={14} />
                            </span>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
            </div>
          </Show>

          <Show when={view() === "create"}>
            <div class="skill-create">
              <h2>{t("skills.createTitle")}</h2>
              <div class="field">
                <label>{t("skills.name")}</label>
                <input type="text" value={name()} autofocus onInput={(event) => setName(event.currentTarget.value)} placeholder={t("skills.namePlaceholder")} />
              </div>
              <div class="field">
                <label>{t("skills.description")}</label>
                <textarea rows={3} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} placeholder={t("skills.descriptionPlaceholder")} />
              </div>
              <div class="field">
                <label>{t("skills.content")}</label>
                <textarea class="skill-editor" rows={12} value={content()} onInput={(event) => setContent(event.currentTarget.value)} placeholder={"# Mi skill\n\nInstrucciones y pasos…"} />
              </div>
              <div class="skill-create-actions">
                <span class="hint">
                  {t("skills.autoId")}: <code>{uniqueId()}</code>
                </span>
                <span style={{ flex: 1 }} />
                <Show when={error()}>
                  <span class="workspace-error">⚠ {error()}</span>
                </Show>
                <button class="button" onClick={() => void importDraft()}>
                  <Icon name="folder-open" size={13} /> {t("skills.import")}
                </button>
                <button class="button" onClick={() => setView("list")}>
                  {t("app.cancel")}
                </button>
                <button class="button primary" disabled={saving() || !name().trim()} onClick={() => void save()}>
                  {t("skills.create")}
                </button>
              </div>
            </div>
          </Show>

          <Show when={view() === "detail"}>
            <div class="skill-detail">
              <div class="skill-detail-header">
                <button
                  class="icon-button"
                  title={t("skills.back")}
                  onClick={() => {
                    setView("list")
                    setEditing(false)
                    setError("")
                  }}
                >
                  <Icon name="arrow-left" size={14} />
                </button>
                <div class="skill-detail-title">
                  <h2>{selected()?.id}</h2>
                  <span class="skill-detail-meta" title={selected()?.directory}>
                    {originLabel(selected()?.origin)} · {selected()?.directory}
                    <Show when={selected()?.autoinvoke === false}> · {t("skills.detail.manual")}</Show>
                  </span>
                </div>
                <span style={{ flex: 1 }} />
                <Show when={error()}>
                  <span class="workspace-error">⚠ {error()}</span>
                </Show>
                <Show when={!editing()}>
                  <Show when={selected()?.origin === "global"}>
                    <button
                      class="icon-button"
                      title={t("skills.remove.confirm")}
                      onClick={() => {
                        const detail = selected()
                        if (detail) remove(detail, true)
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </Show>
                  <button class="button" onClick={() => setEditing(true)}>
                    {t("skills.edit")}
                  </button>
                </Show>
                <Show when={editing()}>
                  <button
                    class="button"
                    onClick={() => {
                      setEditing(false)
                      setEditDescription(selected()?.description ?? "")
                      setEditContent(selected()?.content ?? "")
                    }}
                  >
                    {t("app.cancel")}
                  </button>
                  <button class="button primary" disabled={saving()} onClick={() => void saveEdits()}>
                    {t("skills.saveChanges")}
                  </button>
                </Show>
              </div>
              <div class="skill-tabs">
                <button class={tab() === "description" ? "active" : ""} onClick={() => setTab("description")}>
                  {t("skills.tabs.description")}
                </button>
                <button class={tab() === "content" ? "active" : ""} onClick={() => setTab("content")}>
                  {t("skills.tabs.content")}
                </button>
              </div>
              <div class="skill-detail-body">
                <Show when={tab() === "description"}>
                  <Show when={editing()} fallback={<p class="skill-detail-text">{selected()?.description || "—"}</p>}>
                    <textarea
                      class="skill-editor"
                      rows={5}
                      value={editDescription()}
                      onInput={(event) => setEditDescription(event.currentTarget.value)}
                      placeholder={t("skills.descriptionPlaceholder")}
                    />
                  </Show>
                </Show>
                <Show when={tab() === "content"}>
                  <Show when={editing()} fallback={<pre class="skill-detail-pre">{selected()?.content}</pre>}>
                    <textarea
                      class="skill-editor skill-editor-full"
                      value={editContent()}
                      onInput={(event) => setEditContent(event.currentTarget.value)}
                      placeholder={"# Mi skill\n\nInstrucciones y pasos…"}
                    />
                  </Show>
                </Show>
                <Show when={(selected()?.files?.length ?? 0) > 0}>
                  <span class="hint">
                    {t("skills.detail.files")}: {(selected()?.files ?? []).join(", ")}
                  </span>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
