import { For, Show, createSignal } from "solid-js"
import { t } from "../i18n"
import { state } from "../store"
import { createDockBrowser, createDockTerminal, dockShells, pickDockShell, preferredShell, shellName } from "../dock-tools"
import { Icon } from "./Icons"

/**
 * Guide page ("Start"): one card per entry — Browser and New terminal with the
 * shell caret menu beside its title (DSH layout, no workspace-files card).
 */
export function DockGuide(props: { paneID?: string }) {
  const shells = dockShells()
  const [selectedShell, setSelectedShell] = createSignal(preferredShell())
  const currentShell = () => (selectedShell() || preferredShell() || shells()[0]?.id || "")

  return (
    <div class="guide">
      <div class="guide-logo">
        <Icon name="skill" size={26} />
      </div>
      <div class="guide-cards">
        <button class="guide-card" onClick={() => createDockBrowser({ paneID: props.paneID, replaceGuide: true })}>
          <span class="guide-card-icon">
            <Icon name="globe" size={16} />
          </span>
          <span class="guide-card-text">
            <span class="guide-card-title">{t("guide.browser.title")}</span>
            <span class="guide-card-desc">{t("guide.browser.desc")}</span>
          </span>
          <span class="guide-card-shortcut">Ctrl + T</span>
        </button>

        <div class="guide-card guide-card-split">
          <button class="guide-card-main" onClick={() => void createDockTerminal({ paneID: props.paneID, replaceGuide: true })}>
            <span class="guide-card-icon">
              <Icon name="terminal" size={16} />
            </span>
            <span class="guide-card-text">
              <span class="guide-card-title">{t("guide.terminal.title")}</span>
              <span class="guide-card-desc">{t("guide.terminal.desc")}</span>
            </span>
            <span class="guide-card-shortcut">Ctrl + `</span>
          </button>
          <span class="guide-card-caret" title={t("guide.terminal.shell", { name: shellName(currentShell()) })}>
            <span class="guide-caret-glyph">
              <Icon name="chevron-right" size={13} />
            </span>
            <select
              class="guide-shell-select"
              value={currentShell()}
              onChange={(event) => {
                const id = event.currentTarget.value
                setSelectedShell(id)
                void pickDockShell(id)
              }}
            >
              <Show when={shells().length > 0} fallback={<option value="">{t("guide.terminal.noShells")}</option>}>
                <For each={shells()}>{(shell) => <option value={shell.id}>{shell.name}</option>}</For>
              </Show>
            </select>
          </span>
        </div>
      </div>
    </div>
  )
}
