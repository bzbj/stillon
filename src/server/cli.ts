import process from "node:process"
import { openUrl, runCli } from "./cli-runtime"
import { startStillOnServer } from "./server"
import { manageService } from "./service"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

const argv = process.argv.slice(2)

const result = await runCli(argv, {
  version: VERSION,
  bunVersion: Bun.version,
  startServer: startStillOnServer,
  openUrl,
  log: console.log,
  warn: console.warn,
  manageService: (action, options) => manageService(action, {
    ...options,
    log: console.log,
    warn: console.warn,
  }),
})

if (result.kind === "exited") {
  process.exit(result.code)
}

await new Promise<void>((resolve) => {
  const shutdown = () => {
    resolve()
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
})

await result.stop()
process.exit(0)
