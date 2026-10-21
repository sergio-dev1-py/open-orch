import type { AssistantMessage, FileAttachment, Message, Part, ToolPart } from "@openorch/shared"
import type { ModelMessage } from "ai"

export interface HistoryOptions {
  maxToolOutputChars?: number
  /** Model the transcript is being built for (reasoning replay is model-scoped). */
  model?: { providerID: string; modelID: string }
  /** When false, image parts are dropped (upstream: unsupportedParts). */
  supportsImages?: boolean
}

function dataUriToBytes(url: string): { data: Uint8Array; mediaType: string } | undefined {
  const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) return undefined
  const mediaType = match[1] ?? "application/octet-stream"
  const isBase64 = Boolean(match[2])
  const raw = isBase64 ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8")
  return { data: new Uint8Array(raw), mediaType }
}

function fileParts(files: FileAttachment[] | undefined, supportsImages: boolean) {
  const parts: Array<{ type: "image"; image: Uint8Array; mediaType: string } | { type: "file"; data: Uint8Array; mediaType: string }> = []
  for (const file of files ?? []) {
    const decoded = dataUriToBytes(file.url)
    if (!decoded) continue
    if (decoded.mediaType.startsWith("image/")) {
      if (!supportsImages) continue
      parts.push({ type: "image", image: decoded.data, mediaType: decoded.mediaType })
    } else {
      parts.push({ type: "file", data: decoded.data, mediaType: decoded.mediaType })
    }
  }
  return parts
}

function toolResultOutput(part: ToolPart, maxChars: number) {
  if (part.state.status === "completed") {
    const text = part.state.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
    const media = part.state.content.filter((content) => content.type === "file")
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text
    if (media.length > 0) {
      const value: Array<Record<string, unknown>> = []
      if (clipped) value.push({ type: "text", text: clipped })
      for (const file of media) {
        const decoded = dataUriToBytes(file.url)
        if (!decoded) continue
        value.push({ type: "image", image: decoded.data, mediaType: decoded.mediaType })
      }
      return { type: "content" as const, value }
    }
    return { type: "text" as const, value: clipped || "(no output)" }
  }
  if (part.state.status === "error") {
    const message = part.state.error.length > maxChars ? `${part.state.error.slice(0, maxChars)}\n…(truncated)` : part.state.error
    return { type: "error-text" as const, value: message }
  }
  return { type: "error-text" as const, value: "Tool execution was interrupted before it produced a result." }
}

/** Converts session messages into the model-visible transcript. */
export function toModelMessages(messages: Message[], options: HistoryOptions = {}): ModelMessage[] {
  const maxChars = options.maxToolOutputChars ?? 30_000
  const out: ModelMessage[] = []

  // History is truncated at the latest completed compaction. The checkpoint becomes
  // a user message carrying the structured summary.
  let historyStart = 0
  let checkpoint: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === "compaction" && message.status === "completed") {
      historyStart = i + 1
      checkpoint = message.summary
      break
    }
  }

  if (checkpoint) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `<conversation-checkpoint>\n${checkpoint}\n</conversation-checkpoint>` }],
    } as unknown as ModelMessage)
  }

  for (const message of messages.slice(historyStart)) {
    if (message.role === "user") {
      const content: Array<Record<string, unknown>> = []
      if (message.text) content.push({ type: "text", text: message.text })
      content.push(...fileParts(message.files, options.supportsImages !== false))
      if (content.length === 0) continue
      out.push({ role: "user", content } as unknown as ModelMessage)
      continue
    }
    if (message.role === "synthetic") {
      out.push({ role: "user", content: [{ type: "text", text: message.text }] } as unknown as ModelMessage)
      continue
    }
    if (message.role === "shell") {
      const text = `[shell] ${message.command}\n${message.output ? `\n${message.output}` : ""}`.trim()
      out.push({ role: "user", content: [{ type: "text", text }] } as unknown as ModelMessage)
      continue
    }
    if (message.role === "compaction") {
      continue
    }
    if (message.role === "assistant") {
      pushAssistant(out, message, maxChars, options)
      continue
    }
  }
  return out
}

function pushAssistant(out: ModelMessage[], message: AssistantMessage, maxChars: number, options: HistoryOptions): void {
  // Reasoning and provider-bound text state are only replayable against the model
  // that produced them (upstream: `reuseProviderMetadata` in to-llm-message.ts).
  const sameModel =
    options.model !== undefined &&
    message.model.providerID === options.model.providerID &&
    message.model.modelID === options.model.modelID
  const reuse = sameModel && message.error === undefined

  let assistantContent: Array<Record<string, unknown>> = []
  let toolResults: Array<Record<string, unknown>> = []

  const flush = () => {
    if (assistantContent.length > 0) {
      out.push({ role: "assistant", content: assistantContent } as unknown as ModelMessage)
      assistantContent = []
    }
    if (toolResults.length > 0) {
      out.push({ role: "tool", content: toolResults } as unknown as ModelMessage)
      toolResults = []
    }
  }

  for (const part of message.content as Part[]) {
    if (part.type === "text") {
      // A text part after tool calls starts a new assistant segment.
      if (toolResults.length > 0) flush()
      const providerOptions = reuse && part.providerMetadata ? part.providerMetadata : undefined
      assistantContent.push({ type: "text", text: part.text, ...(providerOptions ? { providerOptions } : {}) })
      continue
    }
    if (part.type === "reasoning") {
      if (toolResults.length > 0) flush()
      if (part.text.length > 0) {
        // Upstream keeps readable reasoning after a model/provider switch (the
        // destination adapter decides how to replay it); never downgrade it to
        // plain text, which made weaker models read old thinking as answers.
        assistantContent.push({
          type: "reasoning",
          text: part.text,
          ...(reuse && part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
        })
      }
      continue
    }
    if (part.type === "tool") {
      if (part.state.status === "streaming") continue
      const input = "input" in part.state ? (part.state.input as Record<string, unknown>) : {}
      assistantContent.push({
        type: "tool-call",
        toolCallId: part.callID,
        toolName: part.tool,
        input: part.state.status === "permission" ? {} : input,
      })
      if (part.state.status === "permission") {
        toolResults.push({
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: { type: "error-text", value: "Tool execution was declined by the user." },
        })
        continue
      }
      toolResults.push({
        type: "tool-result",
        toolCallId: part.callID,
        toolName: part.tool,
        output: toolResultOutput(part, maxChars),
      })
      continue
    }
  }
  flush()
}

/** Renders the last assistant text of a session (used for subagent outputs). */
export function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    const text = message.content
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}
