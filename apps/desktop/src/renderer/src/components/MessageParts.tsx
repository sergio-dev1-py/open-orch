import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type {
  AssistantMessage,
  CompactionMessage,
  FileAttachment,
  Message,
  Part,
  ReasoningPart,
  ShellMessage,
  SyntheticMessage,
  TextPart,
  ToolPart,
  UserMessage,
} from "@openorch/shared"
import { t } from "../i18n"
import { Markdown } from "./Markdown"
import { GROUPABLE_TOOLS, ToolCardView, ToolGroupView } from "./ToolParts"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function formatTokens(tokens: { input: number; output: number }): string {
  const total = tokens.input + tokens.output
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`
  return `${total} tok`
}

function formatCost(cost: number): string {
  if (cost === 0) return ""
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------

function TextPartView(props: { part: TextPart; streaming: boolean }) {
  return <Markdown text={props.part.text} streaming={props.streaming} />
}

function ReasoningPartView(props: { part: ReasoningPart; streaming: boolean }) {
  const [open, setOpen] = createSignal(false)
  const title = () => {
    const firstLine = props.part.text.split("\n").find((line) => line.trim().replaceAll(/[*#]/g, "").trim().length > 3)
    const cleaned = firstLine?.replaceAll(/[*#]/g, "").trim() ?? ""
    return cleaned.length > 4 && cleaned.length < 80 ? cleaned : ""
  }
  return (
    <div class="reasoning">
      <div class="reasoning-header" onClick={() => setOpen(!open())}>
        <Show when={props.streaming} fallback={<span>{open() ? "−" : "+"} {t("thinking.thought")}{title() ? `: ${title()}` : ""}</span>}>
          <span class="spinner" />
          <span>{t("thinking.thinking")}{title() ? `: ${title()}` : ""}</span>
        </Show>
        <Show when={!props.streaming && props.part.text.length > 0}>
          <span class="dur">· {props.part.text.length} chars</span>
        </Show>
      </div>
      <Show when={open()}>
        <div class="reasoning-body">{props.part.text}</div>
      </Show>
    </div>
  )
}

interface PartRun {
  kind: "single" | "group"
  parts: Part[]
}

function toRuns(parts: Part[]): PartRun[] {
  const runs: PartRun[] = []
  let group: ToolPart[] = []
  const flushGroup = () => {
    if (group.length >= 2) runs.push({ kind: "group", parts: [...group] })
    else if (group.length === 1) runs.push({ kind: "single", parts: [...group] })
    group = []
  }
  for (const part of parts) {
    // Empty parts (e.g. the gateway's "No reasoning available." placeholder
    // cleared by the engine) must not render an empty block.
    if (part.type === "reasoning" && part.text.trim().length === 0) continue
    if (part.type === "text" && part.text.length === 0) continue
    if (part.type === "tool" && GROUPABLE_TOOLS.has(part.tool) && part.state.status !== "permission") {
      group.push(part)
      continue
    }
    flushGroup()
    runs.push({ kind: "single", parts: [part] })
  }
  flushGroup()
  return runs
}

// ---------------------------------------------------------------------------
// Message renderers
// ---------------------------------------------------------------------------

function UserMessageView(props: { message: UserMessage }) {
  const images = () => (props.message.files ?? []).filter((file) => file.mime.startsWith("image/"))
  const others = () => (props.message.files ?? []).filter((file) => !file.mime.startsWith("image/"))
  return (
    <div class="msg-user">
      <div class="msg-user-content">
        <Show when={props.message.text}>
          <div>{props.message.text}</div>
        </Show>
        <Show when={(props.message.files?.length ?? 0) > 0}>
          <div class="msg-user-files">
            <For each={images()}>{(file: FileAttachment) => <img src={file.url} alt={file.name ?? "attachment"} />}</For>
            <For each={others()}>{(file: FileAttachment) => <span class="composer-attachment">{file.name ?? file.mime}</span>}</For>
          </div>
        </Show>
      </div>
    </div>
  )
}

function SyntheticMessageView(props: { message: SyntheticMessage }) {
  // Hidden harness notices (Plan/Build mode reminders) are never shown; the model
  // still receives the full text.
  if (props.message.metadata?.hidden === true || props.message.metadata?.source === "plan") return null
  const label = () => props.message.description?.trim()
  const preview = () => {
    const text = props.message.text.replaceAll(/\s+/g, " ").trim()
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
  }
  const [open, setOpen] = createSignal(false)
  return (
    <div class="msg-notice" onClick={() => setOpen(!open())} style={{ cursor: "pointer" }}>
      <span>ℹ</span>
      <span style={{ flex: 1 }}>
        <Show when={label()} fallback={open() ? props.message.text : preview()}>
          <span style={{ color: "var(--text-muted)" }}>{label()}</span>
          <Show when={open()}>
            <div style={{ "margin-top": "6px", "white-space": "pre-wrap" }}>{props.message.text}</div>
          </Show>
        </Show>
      </span>
    </div>
  )
}

function ShellMessageView(props: { message: ShellMessage }) {
  return (
    <div class="msg-shell">
      <div class="msg-shell-header">
        <span style={{ color: "var(--text-faint)" }}>$</span>
        <span style={{ flex: 1 }}>{props.message.command}</span>
        <Show when={props.message.status === "running"}>
          <span class="spinner" />
        </Show>
      </div>
      <Show when={props.message.output}>
        <pre class="msg-shell-output">{props.message.output}</pre>
      </Show>
    </div>
  )
}

function CompactionMessageView(props: { message: CompactionMessage }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="msg-compaction" onClick={() => setOpen(!open())} style={{ cursor: "pointer", display: "block" }}>
      <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
        <Show when={props.message.status === "running"}>
          <span class="spinner" />
        </Show>
        <span>
          <Switch>
            <Match when={props.message.status === "running"}>{t("compaction.running")}</Match>
            <Match when={props.message.status === "failed"}>{t("compaction.failed")}: {props.message.error}</Match>
            <Match when={true}>{t("compaction.completed")}</Match>
          </Switch>
        </span>
        <span style={{ "margin-left": "auto", "font-size": "11px" }}>{open() ? "▾" : "▸"}</span>
      </div>
      <Show when={open() && props.message.summary}>
        <pre>{props.message.summary}</pre>
      </Show>
    </div>
  )
}

export function AssistantMessageView(props: { message: AssistantMessage; showFooter?: boolean }) {
  const runs = createMemo(() => toRuns(props.message.content))
  const streaming = () => props.message.time.completed === undefined
  const duration = () =>
    props.message.time.completed ? props.message.time.completed - props.message.time.created : undefined
  const isLastPart = (part: Part) => props.message.content[props.message.content.length - 1]?.id === part.id

  return (
    <div class="msg-assistant">
      <Show when={props.message.error}>
        <div class="tool-card error">
          <div class="tool-head">
            <span class="tool-icon" style={{ color: "var(--error)" }}>
              ✗
            </span>
            <span class="tool-title">{t("tool.error.title")}</span>
            <span class="tool-subtitle">{props.message.error}</span>
          </div>
        </div>
      </Show>
      <For each={runs()}>
        {(run) => (
          <Switch>
            <Match when={run.kind === "group"}>
              <ToolGroupView parts={run.parts as ToolPart[]} />
            </Match>
            <Match when={true}>
              <For each={run.parts}>
                {(part) => (
                  <Switch>
                    <Match when={part.type === "text"}>
                      <TextPartView part={part as TextPart} streaming={streaming() && isLastPart(part)} />
                    </Match>
                    <Match when={part.type === "reasoning"}>
                      <ReasoningPartView part={part as ReasoningPart} streaming={streaming() && isLastPart(part)} />
                    </Match>
                    <Match when={part.type === "tool"}>
                      <ToolCardView
                        part={part as ToolPart}
                        defaultOpen={
                          (part as ToolPart).state.status === "permission" || (part as ToolPart).state.status === "error"
                        }
                      />
                    </Match>
                  </Switch>
                )}
              </For>
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.showFooter !== false && (props.message.tokens || props.message.error || !streaming())}>
        <div class="assistant-footer">
          <span class="chip">{props.message.agent}</span>
          <span class="chip">{props.message.model.name ?? `${props.message.model.providerID}/${props.message.model.modelID}`}</span>
          <Show when={props.message.model.variant}>
            <span class="chip">{props.message.model.variant}</span>
          </Show>
          <Show when={duration()}>
            <span>{(duration() ?? 0) > 0 ? formatDuration(duration()!) : ""}</span>
          </Show>
          <Show when={props.message.tokens}>
            <span>{formatTokens(props.message.tokens!)}</span>
          </Show>
          <Show when={props.message.cost}>
            <span>{formatCost(props.message.cost!)}</span>
          </Show>
          <Show when={props.message.finish && props.message.finish !== "stop"}>
            <span>· {props.message.finish}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export function MessageView(props: { message: Message; showFooter?: boolean }) {
  return (
    <Switch>
      <Match when={props.message.role === "user"}>
        <UserMessageView message={props.message as UserMessage} />
      </Match>
      <Match when={props.message.role === "assistant"}>
        <AssistantMessageView message={props.message as AssistantMessage} showFooter={props.showFooter} />
      </Match>
      <Match when={props.message.role === "synthetic"}>
        <SyntheticMessageView message={props.message as SyntheticMessage} />
      </Match>
      <Match when={props.message.role === "shell"}>
        <ShellMessageView message={props.message as ShellMessage} />
      </Match>
      <Match when={props.message.role === "compaction"}>
        <CompactionMessageView message={props.message as CompactionMessage} />
      </Match>
      <Match when={true}>
        <div class="msg-notice">Unsupported message</div>
      </Match>
    </Switch>
  )
}
