import path from "node:path"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"

const root = path.resolve(import.meta.dir, "../../..")
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  cacheDir: path.join(root, "test-artifacts/remote-auth-vite"),
  optimizeDeps: { entries: ["scripts/test-fixtures/remote-auth/index.html"] },
  server: { host: "127.0.0.1", port: 5190, strictPort: true, allowedHosts: ["h-00000000000000000000000000000000.localhost"] },
})
await server.listen()
process.on("SIGTERM", async () => { await server.close(); process.exit(0) })
