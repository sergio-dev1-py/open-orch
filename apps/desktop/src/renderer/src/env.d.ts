import type { OpenOrchBridge } from "../../preload/index"

declare global {
  interface Window {
    openorch: OpenOrchBridge
  }
}

export {}
