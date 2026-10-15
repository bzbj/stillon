import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/connect/client"),
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/connect"),
    emptyOutDir: true,
  },
})
