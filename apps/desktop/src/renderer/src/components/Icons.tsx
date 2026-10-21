/**
 * Monochrome UI icons (currentColor, same stroke style as `ToolIcon`): they inherit the
 * theme's text color instead of rendering as colored emoji.
 */

export type IconName =
  | "paperclip"
  | "skill"
  | "gear"
  | "plus"
  | "folder"
  | "folder-open"
  | "search"
  | "trash"
  | "file"
  | "chevron-right"
  | "arrow-left"
  | "arrow-right"
  | "eye"
  | "penguin"
  | "globe"
  | "terminal"
  | "columns"
  | "split"
  | "external"
  | "plug"
  | "clock"
  | "calendar"
  | "repeat"
  | "play"
  | "pause"
  | "bell"
  | "check"
  | "x"

const PATHS: Record<IconName, string> = {
  paperclip: "M21 11.5l-8.8 8.8a5.7 5.7 0 01-8.1-8.1l8.2-8.2a3.8 3.8 0 015.4 5.4l-8.2 8.2a1.9 1.9 0 01-2.7-2.7l7.6-7.6",
  skill: "M12 3l2.2 5.4L20 9.6l-4.4 3.8L16.8 20 12 16.7 7.2 20l1.2-6.6L4 9.6l5.8-1.2z",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM12 2.8v2.4M12 18.8v2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7",
  plus: "M12 5v14M5 12h14",
  folder: "M4 5h5l2 3h9v11H4z",
  "folder-open": "M4 5h5l2 3h9v3H4zM4 11h17l-2.5 8H4z",
  search: "M11 4a7 7 0 105.2 11.7L21 20l-1.4-1.4-3.4-3.4A7 7 0 0011 4z",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  "chevron-right": "M9 6l6 6-6 6",
  "arrow-left": "M19 12H5M11 6l-6 6 6 6",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  eye: "M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zM12 14.8a2.8 2.8 0 100-5.6 2.8 2.8 0 000 5.6z",
  penguin: "M12 3.2c1.9 0 3.2 1.3 3.2 3.2v1.4c1.6 1.5 2.6 3.6 2.6 5.9 0 3.2-2.6 5.6-5.8 5.6s-5.8-2.4-5.8-5.6c0-2.3 1-4.4 2.6-5.9V6.4c0-1.9 1.3-3.2 3.2-3.2zM10.3 7.4h.01M13.7 7.4h.01M11 9.4h2l-1 1.5z",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12.5 15H17",
  columns: "M4 4h16v16H4zM13 4v16",
  split: "M4 4h7v16H4zM13 4h7v16h-7z",
  external: "M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2",
  calendar: "M5 5h14v15H5zM8 3v4M16 3v4M5 9h14",
  repeat: "M17 3l3 3-3 3M20 6H8a4 4 0 00-4 4M7 21l-3-3 3-3M4 18h12a4 4 0 004-4",
  play: "M8 5l11 7-11 7z",
  pause: "M8 5v14M16 5v14",
  bell: "M12 3a5 5 0 00-5 5v3l-2 3h14l-2-3V8a5 5 0 00-5-5zM10 19a2 2 0 004 0",
  check: "M5 13l4 4L19 7",
  x: "M6 6l12 12M18 6L6 18",
}

export function Icon(props: { name: IconName; size?: number }) {
  const size = () => props.size ?? 15
  return (
    <svg
      class="ui-icon"
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  )
}
