import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import type { FileDiffInfo, ToolContent, ToolPart, ToolState } from "@openorch/shared"
import { t } from "../i18n"
import { DiffView } from "./Diff"
import { Markdown } from "./Markdown"

export function ToolIcon(props: { name: string; size?: number }) {
  const size = () => props.size ?? 15
  const path = createMemo(() => {
    switch (props.name) {
      case "shell":
        return "M3 5l4 4-4 4M9 13h6"
      case "read":
        return "M5 3h9l5 5v13H5zM14 3v5h5"
      case "write":
      case "edit":
      case "patch":
        return "M4 20h4L20 8l-4-4L4 16v4zM13 7l4 4"
      case "glob":
        return "M4 4h6l2 3h8v11H4z"
      case "grep":
        return "M11 4a7 7 0 105.2 11.7L21 20l-1.4-1.4-3.4-3.4A7 7 0 0011 4z"
      case "webfetch":
      case "websearch":
        return "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"
      case "subagent":
        return "M7 7h10v10H7zM4 4h3v3H4zM17 17h3v3h-3zM17 4h3v3h-3zM4 17h3v3H4z"
      case "question":
        return "M12 3a9 9 0 100 18 9 9 0 000-18zM9.6 9.2A2.6 2.6 0 0112 7.5c1.5 0 2.6 1 2.6 2.3 0 1.7-2 2-2.4 3.4M12 16.4h.01"
      case "skill":
        return "M12 3l2.2 5.4L20 9.6l-4.4 3.8L16.8 20 12 16.7 7.2 20l1.2-6.6L4 9.6l5.8-1.2z"
      case "execute":
        return "M5 4l8 8-8 8zM15 20h4"
      default:
        return "M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v5M12 16h.01"
    }
  })
  return (
    <svg width={size()} height={size()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d={path()} />
    </svg>
  )
}

interface ToolDisplay {
  icon: string
  title: string
  subtitle: string
}

export function toolDisplay(part: ToolPart): ToolDisplay {
  const input = (part.state as { input?: Record<string, unknown> } & ToolState).input as Record<string, unknown> | undefined
  const str = (key: string): string => {
    const value = input?.[key]
    return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)
  }
  switch (part.tool) {
    case "shell":
      return { icon: "shell", title: t("shell.title"), subtitle: str("command") }
    case "read": {
      const offset = input?.offset ? `:${input.offset}` : ""
      return { icon: "read", title: t("read.title"), subtitle: `${str("path")}${offset}` }
    }
    case "write":
      return { icon: "write", title: t("write.title"), subtitle: str("path") }
    case "edit":
      return { icon: "edit", title: t("edit.title"), subtitle: str("path") }
    case "patch": {
      const files = (part.state as { metadata?: { files?: FileDiffInfo[] } }).metadata?.files
      return { icon: "patch", title: t("patch.title"), subtitle: files ? `${files.length} file(s)` : "" }
    }
    case "glob":
      return { icon: "glob", title: t("glob.title"), subtitle: str("pattern") }
    case "grep":
      return { icon: "grep", title: t("grep.title"), subtitle: str("pattern") }
    case "webfetch":
      return { icon: "webfetch", title: t("webfetch.title"), subtitle: str("url") }
    case "websearch":
      return { icon: "websearch", title: t("websearch.title"), subtitle: str("query") }
    case "subagent": {
      const model = (part.state as { metadata?: { model?: string } }).metadata?.model
      const description = str("description")
      return {
        icon: "subagent",
        title: `${t("subagent.title")} · ${str("agent")}`,
        subtitle: model ? `${description} · ${model}` : description,
      }
    }
    case "question":
      return { icon: "question", title: t("question.tool.title"), subtitle: "" }
    case "skill":
      return { icon: "skill", title: t("skill.title"), subtitle: str("id") }
    case "execute": {
      const code = typeof input?.code === "string" ? input.code : ""
      const calls = (part.state as { metadata?: { calls?: unknown[] } }).metadata?.calls
      const summary = calls ? `${calls.length} tool call${calls.length === 1 ? "" : "s"}` : ""
      const firstLine = code.split("\n").find((line) => line.trim()) ?? ""
      return { icon: "execute", title: t("codemode.title"), subtitle: summary || firstLine.slice(0, 80) }
    }
    default: {
      const first = Object.entries(input ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([, value]) => String(value))[0]
      return { icon: "generic", title: part.tool, subtitle: first ?? "" }
    }
  }
}

function StatusBadge(props: { state: ToolState }) {
  return (
    <Switch>
      <Match when={props.state.status === "streaming" || props.state.status === "running"}>
        <span class="spinner" />
      </Match>
      <Match when={props.state.status === "permission"}>
        <span style={{ color: "var(--warning)" }}>◇ {t("tool.permission.waiting")}</span>
      </Match>
      <Match when={props.state.status === "completed"}>
        <span style={{ color: "var(--success)" }}>✓</span>
      </Match>
      <Match when={props.state.status === "error"}>
        <span style={{ color: "var(--error)" }}>✗</span>
      </Match>
    </Switch>
  )
}

function textOf(content: ToolContent[] | undefined): string {
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n")
}

function filesOf(state: ToolState): FileDiffInfo[] | undefined {
  const metadata = (state as { metadata?: { files?: FileDiffInfo[] } }).metadata
  return metadata?.files
}

export function ToolBody(props: { part: ToolPart }) {
  const state = () => props.part.state
  const content = () => (state().status === "completed" ? (state() as { content: ToolContent[] }).content : [])
  const text = () => textOf(content())
  const files = () => filesOf(state())
  const images = () => content().filter((item) => item.type === "file") as { url: string; mime: string }[]

  const input = () => {
    const value = state() as { input?: unknown }
    return value.input
  }

  return (
    <Switch>
      {/* Errors first: they must always be visible regardless of the tool. */}
      <Match when={state().status === "error"}>
        <div class="tool-error">{(state() as { error: string }).error}</div>
      </Match>
      <Match when={state().status === "streaming"}>
        <pre style={{ color: "var(--text-faint)" }}>{(state() as { input: string }).input || "…"}</pre>
      </Match>
      <Match when={state().status === "permission"}>
        <div class="tool-empty">{t("tool.permission.waiting")}…</div>
      </Match>
      <Match when={props.part.tool === "shell"}>
        <pre>
          <span style={{ color: "var(--text-faint)" }}>$ </span>
          {String((input() as Record<string, unknown>)?.command ?? "")}
          {"\n\n"}
          {text() || (state().status === "running" ? "…" : "")}
        </pre>
      </Match>
      <Match when={props.part.tool === "write" || props.part.tool === "edit" || props.part.tool === "patch"}>
        <Show when={files()} fallback={<ToolTextFallback text={text()} status={state().status} />}>
          <DiffView files={files()!} />
        </Show>
      </Match>
      <Match when={props.part.tool === "read"}>
        <Show
          when={images().length > 0}
          fallback={
            <pre style={{ "max-height": "380px" }}>{text() || (state().status === "running" ? "…" : t("tool.status.running"))}</pre>
          }
        >
          <For each={images()}>{(file) => <img class="image-preview" src={file.url} alt="read result" />}</For>
        </Show>
      </Match>
      <Match when={props.part.tool === "webfetch" || props.part.tool === "websearch"}>
        <Markdown text={text()} />
      </Match>
      <Match when={props.part.tool === "grep" || props.part.tool === "glob"}>
        <pre>{text() || (state().status === "running" ? "…" : "")}</pre>
      </Match>
      <Match when={props.part.tool === "subagent"}>
        <SubagentBody part={props.part} />
      </Match>
      <Match when={props.part.tool === "execute"}>
        <ExecuteBody part={props.part} />
      </Match>
      <Match when={true}>
        <ToolTextFallback text={text()} status={state().status} />
      </Match>
    </Switch>
  )
}

function ToolTextFallback(props: { text: string; status: string }) {
  return (
    <Show when={props.text} fallback={<div class="tool-empty">{props.status === "running" ? "…" : ""}</div>}>
      <pre>{props.text}</pre>
    </Show>
  )
}

function SubagentBody(props: { part: ToolPart }) {
  const state = () => props.part.state
  const metadata = () =>
    (props.part.state as { metadata?: { sessionID?: string; background?: boolean; model?: string } }).metadata
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
      <div class="row" style={{ gap: "6px" }}>
        <Show when={metadata()?.model}>
          <span class="badge discovered" title={t("subagent.model")}>
            {metadata()?.model}
          </span>
        </Show>
        <Show when={metadata()?.background}>
          <span class="badge">{t("subagent.background")}</span>
        </Show>
      </div>
      <Show when={state().status === "completed"}>
        <pre>
          {(state() as { content: ToolContent[] }).content
            .filter((item) => item.type === "text")
            .map((item) => (item as { text: string }).text)
            .join("\n")}
        </pre>
      </Show>
      <Show when={metadata()?.sessionID}>
        <button
          class="link-button"
          onClick={() => {
            const sessionID = metadata()?.sessionID
            if (!sessionID) return
            void import("../store").then(({ selectSession }) => selectSession(sessionID))
          }}
        >
          {t("subagent.open")} →
        </button>
      </Show>
    </div>
  )
}

interface ExecuteMetadata {
  console?: string[]
  calls?: { path: string; status: string; error?: string }[]
  error?: string
}

function ExecuteBody(props: { part: ToolPart }) {
  const state = () => props.part.state
  const code = () => {
    const input = (state() as { input?: { code?: string } }).input
    return typeof input?.code === "string" ? input.code : ""
  }
  const metadata = (): ExecuteMetadata => ((state() as { metadata?: ExecuteMetadata }).metadata ?? {})
  const resultText = () => {
    if (state().status !== "completed") return ""
    return textOf((state() as { content: ToolContent[] }).content)
  }

  return (
    <div class="execute-body">
      <Show when={code()}>
        <Markdown text={`\`\`\`js\n${code()}\n\`\`\``} />
      </Show>
      <Show when={(metadata().calls?.length ?? 0) > 0}>
        <div class="execute-calls">
          <For each={metadata().calls}>
            {(call) => (
              <div class="execute-call">
                <span class={call.status === "completed" ? "ok" : "err"}>{call.status === "completed" ? "✓" : "✗"}</span>
                <span class="path">{call.path}</span>
                <Show when={call.error}>
                  <span class="err" style={{ "margin-left": "auto" }}>
                    {call.error}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={resultText()}>
        <pre>{resultText()}</pre>
      </Show>
    </div>
  )
}

export function ToolCardView(props: { part: ToolPart; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const display = createMemo(() => toolDisplay(props.part))
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const state = () => props.part.state

  // Errors and permission waits are surfaced expanded, mirroring upstream.
  createEffect(() => {
    const status = props.part.state.status
    if (status === "error" || status === "permission") setOpen(true)
  })

  const toggle = () => {
    setOpen(!open())
    props.onOpenChange?.(open())
  }

  return (
    <div
      class={`tool-card ${state().status === "permission" ? "permission" : ""} ${state().status === "error" ? "error" : ""}`}
    >
      <div class="tool-head" onClick={toggle}>
        <span class="tool-icon">
          <ToolIcon name={display().icon} />
        </span>
        <span class="tool-title">{display().title}</span>
        <span class="tool-subtitle">{display().subtitle}</span>
        <span class="tool-status">
          <StatusBadge state={state()} />
          <span>{open() ? "▾" : "▸"}</span>
        </span>
      </div>
      <Show when={open()}>
        <div class="tool-body">
          <ToolBody part={props.part} />
        </div>
      </Show>
    </div>
  )
}

/** Collapses runs of read/glob/grep tool calls into one activity card. */
export function ToolGroupView(props: { parts: ToolPart[] }) {
  const [open, setOpen] = createSignal(false)
  const counts = createMemo(() => {
    const summary: Record<string, number> = {}
    for (const part of props.parts) summary[part.tool] = (summary[part.tool] ?? 0) + 1
    return Object.entries(summary)
      .map(([tool, count]) => `${count} ${tool}`)
      .join(", ")
  })
  const running = createMemo(() => props.parts.some((part) => part.state.status === "running" || part.state.status === "streaming"))
  const failed = createMemo(() => props.parts.some((part) => part.state.status === "error"))

  return (
    <div class={`tool-card ${failed() ? "error" : ""}`}>
      <div class="tool-head" onClick={() => setOpen(!open())}>
        <span class="tool-icon">
          <ToolIcon name="grep" />
        </span>
        <span class="tool-title">{t("tool.group.explored")}</span>
        <span class="tool-subtitle">{counts()}</span>
        <span class="tool-status">
          <Show when={running()} fallback={<span style={{ color: failed() ? "var(--error)" : "var(--success)" }}>{failed() ? "✗" : "✓"}</span>}>
            <span class="spinner" />
          </Show>
          <span>{open() ? "▾" : "▸"}</span>
        </span>
      </div>
      <Show when={open()}>
        <div class="tool-body">
          <div class="tool-group">
            <For each={props.parts}>{(part) => <ToolCardView part={part} defaultOpen={false} />}</For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export const GROUPABLE_TOOLS = new Set(["read", "glob", "grep"])
