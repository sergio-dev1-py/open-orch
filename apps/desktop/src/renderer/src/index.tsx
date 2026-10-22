import { render } from "solid-js/web"
import { App } from "./App"
import "./styles/index.css"

// Dropping a file/folder on the window would otherwise navigate to file:// and
// break the app: swallow the default everywhere. The workspace picker handles its
// own drops (and calls preventDefault itself first).
window.addEventListener("dragover", (event) => event.preventDefault())
window.addEventListener("drop", (event) => event.preventDefault())

// Keep renderer failures diagnosable instead of disappearing behind a blank or
// frozen window. These logs also surface errors from message list rendering.
window.addEventListener("error", (event) => {
  console.error("[renderer] uncaught error:", event.error ?? event.message)
})
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] unhandled rejection:", event.reason)
})

render(() => <App />, document.getElementById("root")!)
