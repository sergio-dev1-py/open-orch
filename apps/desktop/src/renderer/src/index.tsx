import { render } from "solid-js/web"
import { App } from "./App"
import "./styles/index.css"

// Dropping a file/folder on the window would otherwise navigate to file:// and
// break the app: swallow the default everywhere. The workspace picker handles its
// own drops (and calls preventDefault itself first).
window.addEventListener("dragover", (event) => event.preventDefault())
window.addEventListener("drop", (event) => event.preventDefault())

render(() => <App />, document.getElementById("root")!)
