import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

const shared = resolve(__dirname, "../../packages/shared/src/index.ts")
const core = resolve(__dirname, "../../packages/core/src/index.ts")

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@openorch/core": core,
        "@openorch/shared": shared,
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        external: ["electron", "@lydell/node-pty", "@vscode/ripgrep", "ws"],
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        "@openorch/shared": shared,
      },
    },
    plugins: [
      {
        // Sandboxed webview guests need a CommonJS preload: emit it verbatim.
        name: "openorch-guest-preload",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "guest.cjs",
            source: readFileSync(resolve(__dirname, "src/preload/guest.cjs"), "utf8"),
          })
        },
      },
    ],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [solid()],
    resolve: {
      alias: {
        "@openorch/shared": shared,
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
})
