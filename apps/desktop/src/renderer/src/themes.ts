import { createSignal } from "solid-js"
import { state } from "./store"

export type ThemeID = "light" | "dark" | "nord" | "gruvbox" | "tokyo"
export type ThemeSelection = ThemeID | "system"

export interface ThemeDef {
  id: ThemeID
  label: "settings.theme.light" | "settings.theme.dark" | "settings.theme.nord" | "settings.theme.gruvbox" | "settings.theme.tokyo"
  kind: "light" | "dark"
  shiki: string
  terminal: { background: string; foreground: string; cursor: string; selectionBackground: string }
}

export const THEMES: ThemeDef[] = [
  {
    id: "light",
    label: "settings.theme.light",
    kind: "light",
    shiki: "github-light",
    terminal: { background: "#ffffff", foreground: "#1c2129", cursor: "#3d6fdd", selectionBackground: "#dbe4f7" },
  },
  {
    id: "dark",
    label: "settings.theme.dark",
    kind: "dark",
    shiki: "one-dark-pro",
    terminal: { background: "#0e1014", foreground: "#d6dae2", cursor: "#7aa2f7", selectionBackground: "#1d2740" },
  },
  {
    id: "nord",
    label: "settings.theme.nord",
    kind: "dark",
    shiki: "nord",
    terminal: { background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", selectionBackground: "#3b4252" },
  },
  {
    id: "gruvbox",
    label: "settings.theme.gruvbox",
    kind: "dark",
    shiki: "gruvbox-dark-medium",
    terminal: { background: "#1d2021", foreground: "#ebdbb2", cursor: "#fabd2f", selectionBackground: "#3c3836" },
  },
  {
    id: "tokyo",
    label: "settings.theme.tokyo",
    kind: "dark",
    shiki: "tokyo-night",
    terminal: { background: "#1a1b26", foreground: "#c0caf5", cursor: "#7aa2f7", selectionBackground: "#2f3549" },
  },
]

const [systemDark, setSystemDark] = createSignal(false)

export { systemDark }

export function watchSystemTheme(): void {
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  setSystemDark(query.matches)
  query.addEventListener("change", (event) => setSystemDark(event.matches))
}

/** Resolved theme id (never "system"). Reactive. */
export function resolvedThemeID(): ThemeID {
  const selection = (state.config?.theme ?? "light") as ThemeSelection
  if (selection === "system") return systemDark() ? "dark" : "light"
  return THEMES.some((theme) => theme.id === selection) ? (selection as ThemeID) : "light"
}

export function currentTheme(): ThemeDef {
  return THEMES.find((theme) => theme.id === resolvedThemeID()) ?? THEMES[0]
}
