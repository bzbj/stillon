import { refreshCliEnvironment } from "./cli-environment"
import process from "node:process"
import { APP_VERSION } from "../shared/branding"
import { openUrl, runCli } from "./cli-runtime"

const argv = process.argv.slice(2)

const result = await runCli(argv, {
  version: APP_VERSION,
  bunVersion: Bun.version,
  startServer: async (options) => {
    const { startStillOnServer } = await import("./server")
    const environment = await refreshCliEnvironment()
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === "PATH") delete process.env[key]
    process.env.PATH = environment.PATH
    return startStillOnServer(options)
  },
  openUrl,
  log: console.log,
  warn: console.warn,
  manageService: async (action, options) => {
    const { manageService } = await import("./service")
    return manageService(action, {
      ...options,
      recordInstallation: true,
      log: console.log,
      warn: console.warn,
    })
  },
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
