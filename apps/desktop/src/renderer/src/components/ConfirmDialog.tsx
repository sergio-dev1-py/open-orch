import { Show, createEffect, onCleanup } from "solid-js"
import { t } from "../i18n"
import { closeConfirm, confirmRequest } from "../store"

export function ConfirmDialog() {
  const confirm = async () => {
    const request = confirmRequest()
    if (!request) return
    closeConfirm()
    await request.onConfirm()
  }

  // Escape cancels the dialog.
  createEffect(() => {
    if (!confirmRequest()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        closeConfirm()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  return (
    <Show when={confirmRequest()}>
      {(request) => (
        <div
          class="modal-backdrop confirm-backdrop"
          onClick={() => closeConfirm()}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeConfirm()
          }}
        >
          <div
            class="confirm-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="confirm-title">
              <span style={{ color: request().danger ? "var(--error)" : "var(--accent)" }}>{request().danger ? "⚠" : "?"}</span>
              {request().title}
            </div>
            <div class="confirm-message">{request().message}</div>
            <Show when={request().note}>
              <div class="confirm-note">{request().note}</div>
            </Show>
            <div class="confirm-actions">
              <button class="button" onClick={() => closeConfirm()}>
                {t("app.cancel")}
              </button>
              <button class={`button ${request().danger ? "danger-solid" : "primary"}`} autofocus onClick={() => void confirm()}>
                {request().confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
