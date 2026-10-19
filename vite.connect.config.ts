import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { startupShellPlugin } from "./scripts/startup-shell"

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/connect/client"),
  publicDir: false,
  plugins: [react(), startupShellPlugin("portal")],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/connect"),
    emptyOutDir: true,
  },
})
