import { For, Show, createMemo, createSignal } from "solid-js"
import type { QuestionAnswer, QuestionRequest } from "@openorch/shared"
import { t } from "../i18n"
import { activePermissions, activeQuestions, replyPermission, replyQuestion } from "../store"

export function PermissionDock() {
  const [feedback, setFeedback] = createSignal("")
  const [showFeedback, setShowFeedback] = createSignal(false)

  const reply = async (requestID: string, value: "once" | "always" | "reject") => {
    await replyPermission(requestID, value, value === "reject" ? feedback() || undefined : undefined)
    setFeedback("")
    setShowFeedback(false)
  }

  return (
    <For each={activePermissions()}>
      {(request) => (
        <div class="dock permission">
          <div class="dock-title">
            <span style={{ color: "var(--warning)" }}>◇</span>
            {t("tool.permission.title")}
            <span class="badge" style={{ "margin-left": "auto" }}>{request.action}</span>
          </div>
          <Show when={request.message}>
            <div style={{ "font-size": "12.5px", color: "var(--text-muted)" }}>{request.message}</div>
          </Show>
          <div class="dock-rows">
            <For each={request.resources.slice(0, 8)}>{(resource) => <div>{resource}</div>}</For>
          </div>
          <Show when={showFeedback()}>
            <input
              type="text"
              placeholder={t("tool.permission.feedback")}
              value={feedback()}
              onInput={(event) => setFeedback(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void reply(request.id, "reject")
              }}
            />
          </Show>
          <div class="dock-actions">
            <button class="button danger" onClick={() => (feedback() ? void reply(request.id, "reject") : setShowFeedback(true))}>
              {t("tool.permission.reject")}
            </button>
            <button class="button" onClick={() => void reply(request.id, "always")}>
              {t("tool.permission.always")}
            </button>
            <button class="button primary" onClick={() => void reply(request.id, "once")} autofocus>
              {t("tool.permission.once")}
            </button>
          </div>
        </div>
      )}
    </For>
  )
}

/**
 * Question wizard: one question per step with mini-tabs (mirrors upstream's form
 * tabs: numbered prompts plus a final Submit tab).
 */
export function QuestionBlock(props: { request: QuestionRequest }) {
  const [tab, setTab] = createSignal(0)
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({})
  const [custom, setCustom] = createSignal<Record<string, string>>({})

  const questions = () => props.request.questions
  const lastTab = () => questions().length
  const isSubmitTab = () => tab() >= lastTab()
  const current = () => questions()[Math.min(tab(), lastTab() - 1)]

  const selected = (question: string): string[] => answers()[question] ?? []
  const customValue = (question: string): string => custom()[question] ?? ""

  const isAnswered = (index: number): boolean => {
    const question = questions()[index]
    if (!question) return false
    return selected(question.question).length > 0 || customValue(question.question).trim().length > 0
  }

  const select = (question: string, label: string, multiple: boolean | undefined) => {
    setAnswers((currentAnswers) => {
      const list = currentAnswers[question] ?? []
      if (multiple) {
        return { ...currentAnswers, [question]: list.includes(label) ? list.filter((entry) => entry !== label) : [...list, label] }
      }
      return { ...currentAnswers, [question]: [label] }
    })
    // Single-choice questions advance automatically, like upstream's instant submit.
    if (!multiple) {
      const index = questions().findIndex((entry) => entry.question === question)
      if (index !== -1) {
        setTimeout(() => setTab(Math.min(index + 1, lastTab())), 260)
      }
    }
  }

  const submit = async () => {
    const result: QuestionAnswer[] = questions().map((question) => {
      const picked = selected(question.question)
      const own = customValue(question.question).trim()
      const list = own && !picked.includes(own) ? [...picked, own] : picked
      return { question: question.question, answers: list }
    })
    await replyQuestion(props.request.id, result)
  }

  return (
    <div class="dock question-wizard">
      <div class="dock-title">
        <span style={{ color: "var(--accent)" }}>?</span>
        {t("question.title")}
        <span class="badge" style={{ "margin-left": "auto" }}>
          {t("question.progress", { current: Math.min(tab() + 1, lastTab()), total: questions().length })}
        </span>
      </div>

      {/* Mini tabs: one per question plus the submit step. */}
      <div class="question-tabs">
        <For each={questions()}>
          {(question, index) => (
            <button
              class={`question-tab ${tab() === index() ? "active" : ""} ${isAnswered(index()) ? "answered" : ""}`}
              title={question.header || question.question}
              onClick={() => setTab(index())}
            >
              <span>{index() + 1}</span>
              <Show when={isAnswered(index())}>
                <span class="check">✓</span>
              </Show>
            </button>
          )}
        </For>
        <button class={`question-tab submit ${isSubmitTab() ? "active" : ""}`} onClick={() => setTab(lastTab())}>
          {t("question.submit")}
        </button>
      </div>

      <div class="question-body">
        <Show
          when={!isSubmitTab()}
          fallback={
            <div class="question-summary">
              <div class="q">{t("question.review")}</div>
              <For each={questions()}>
                {(question, index) => (
                  <div class="question-summary-row">
                    <span class="mark">{isAnswered(index()) ? "✓" : "○"}</span>
                    <span class="label">{question.header || question.question}</span>
                    <span class="value">
                      {selected(question.question).join(", ") || customValue(question.question).trim() || t("question.unanswered")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <div class="question-block">
            <Show when={current().header}>
              <div class="question-header">{current().header}</div>
            </Show>
            <div class="q">{current().question}</div>
            <Show when={current().multiple}>
              <div class="question-hint">{t("question.multiple")}</div>
            </Show>
            <For each={current().options}>
              {(option) => (
                <div
                  class={`question-option ${selected(current().question).includes(option.label) ? "selected" : ""}`}
                  onClick={() => select(current().question, option.label, current().multiple)}
                >
                  <span>{current().multiple ? (selected(current().question).includes(option.label) ? "☑" : "☐") : selected(current().question).includes(option.label) ? "◉" : "○"}</span>
                  <span>
                    <div class="label">{option.label}</div>
                    <Show when={option.description}>
                      <div class="desc">{option.description}</div>
                    </Show>
                  </span>
                </div>
              )}
            </For>
            <input
              type="text"
              placeholder={t("question.own")}
              value={customValue(current().question)}
              onInput={(event) => setCustom({ ...custom(), [current().question]: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  setTab(Math.min(tab() + 1, lastTab()))
                }
              }}
            />
          </div>
        </Show>
      </div>

      <div class="dock-actions question-actions">
        <button class="button" disabled={tab() === 0} onClick={() => setTab(Math.max(0, tab() - 1))}>
          ← {t("question.back")}
        </button>
        <Show
          when={isSubmitTab()}
          fallback={
            <button class="button primary" disabled={tab() >= lastTab()} onClick={() => setTab(Math.min(lastTab(), tab() + 1))}>
              {t("question.next")} →
            </button>
          }
        >
          <button class="button primary" onClick={() => void submit()}>
            {t("question.submit")}
          </button>
        </Show>
        <Show when={!isSubmitTab() && tab() < lastTab()}>
          <button class="link-button" style={{ "margin-left": "auto" }} onClick={() => void submit()}>
            {t("question.sendNow")}
          </button>
        </Show>
      </div>
      <Show when={isSubmitTab()}>
        <div class="question-hint">{t("question.sendHint")}</div>
      </Show>
    </div>
  )
}

export function QuestionDock() {
  // Requests are answered one at a time; the rest wait their turn.
  const first = createMemo(() => activeQuestions()[0])
  return (
    <Show when={first()}>{(request) => <QuestionBlock request={request()} />}</Show>
  )
}
