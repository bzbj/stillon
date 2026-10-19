import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { startupShellPlugin } from "./scripts/startup-shell"
import { precompressStaticAssets } from "./scripts/precompress-static-assets"

const CONNECT_OUT_DIR = path.resolve(import.meta.dirname, "dist/connect")

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/connect/client"),
  publicDir: false,
  plugins: [react(), startupShellPlugin("portal"), {
    name: "stillon-connect-precompress-static-assets",
    apply: "build",
    async closeBundle() { await precompressStaticAssets(CONNECT_OUT_DIR) },
  }],
  build: {
    outDir: CONNECT_OUT_DIR,
    emptyOutDir: true,
  },
})
