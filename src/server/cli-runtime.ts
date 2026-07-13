import process from "node:process"
import { spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX } from "../shared/branding"
import type { ShareMode } from "../shared/share"
import { assertNoHostOverride, getShareCliFlag, isShareEnabled, isTokenShareMode } from "../shared/share"
import { PROD_SERVER_PORT } from "../shared/ports"
import type { ServiceAction } from "./service/types"
import { logShareDetails, renderTerminalQr, startShareTunnel, type StartedShareTunnel } from "./share"

export interface CliOptions {
  port: number
  host: string
  openBrowser: boolean
  share: ShareMode
  password: string | null
  strictPort: boolean
}

export interface StartedCli {
  kind: "started"
  stop: () => Promise<void>
}

export interface ExitedCli {
  kind: "exited"
  code: number
}

export type CliRunResult = StartedCli | ExitedCli

export interface CliRuntimeDeps {
  version: string
  bunVersion: string
  startServer: (options: CliOptions & {
    onMigrationProgress?: (message: string) => void
    trustProxy?: boolean
  }) => Promise<{ port: number; stop: () => Promise<void> }>
  openUrl: (url: string) => void
  log: (message: string) => void
  warn: (message: string) => void
  renderShareQr?: (url: string) => Promise<string>
  startShareTunnel?: (localUrl: string, shareMode: Exclude<ShareMode, false>) => Promise<StartedShareTunnel>
  manageService: (action: ServiceAction, options: { port: number; environmentFile?: string }) => Promise<void>
}

type ParsedArgs =
  | { kind: "run"; options: CliOptions }
  | { kind: "service"; action: ServiceAction; options: { port: number; environmentFile?: string } }
  | { kind: "help" }
  | { kind: "version" }

const MINIMUM_BUN_VERSION = "1.3.5"

function throwShareConflict(share: Exclude<ShareMode, false>, hostFlag: "--host" | "--remote"): never {
  throw new Error(`${getShareCliFlag(share)} cannot be used with ${hostFlag}`)
}

function printHelp() {
  console.log(`${APP_NAME} — local-only project chat UI

Usage:
  ${CLI_COMMAND} [options]
  ${CLI_COMMAND} service <install|status|logs|uninstall> [options]

Options:
  --port <number>      Port to listen on (default: ${PROD_SERVER_PORT})
  --host <host>        Bind to a specific host or IP
  --remote             Shortcut for --host 0.0.0.0
  --share              Create a password-protected Cloudflare quick tunnel
  --cloudflared <token>
                       Run a named Cloudflare tunnel from a token
  --password <secret>  Require a password before loading the app
  --strict-port        Fail instead of trying another port
  --no-open            Don't open browser automatically
  --version            Print version and exit
  --help               Show this help message

Background service:
  service install      Install and start the native per-user background service
  service status       Show the native service status
  service logs         Show recent service logs
  service uninstall    Stop and remove the native background service

Service install options:
  --port <number>      Fixed service port (default: ${PROD_SERVER_PORT})
  --env-file <path>    Load service-only environment variables from this file`)
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === "service") {
    const action = argv[1]
    if (action === "--help" || action === "-h") return { kind: "help" }
    if (!action) {
      throw new Error("Missing service action: expected install, status, logs, or uninstall")
    }
    if (action !== "install" && action !== "status" && action !== "logs" && action !== "uninstall") {
      throw new Error(`Unknown service action: ${action}`)
    }

    let port = PROD_SERVER_PORT
    let environmentFile: string | undefined
    const serviceArgs = argv.slice(2)
    if (action === "install") {
      for (let index = 0; index < serviceArgs.length; index += 1) {
        const arg = serviceArgs[index]
        if (arg !== "--port" && arg !== "--env-file") {
          throw new Error(`Unexpected argument for service install: ${arg}`)
        }
        const value = serviceArgs[index + 1]
        if (!value || value.startsWith("-")) throw new Error(`Missing value for ${arg}`)
        if (arg === "--port") {
          port = Number(value)
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid service port: ${value}`)
          }
        } else {
          environmentFile = value
        }
        index += 1
      }
    } else if (serviceArgs.length > 0) {
      throw new Error(`Unexpected argument for service ${action}: ${serviceArgs[0]}`)
    }

    return { kind: "service", action, options: { port, ...(environmentFile ? { environmentFile } : {}) } }
  }

  let port = PROD_SERVER_PORT
  let host = "127.0.0.1"
  let openBrowser = true
  let share: ShareMode = false
  let password: string | null = null
  let sawHost = false
  let sawRemote = false
  let strictPort = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--version" || arg === "-v") {
      return { kind: "version" }
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" }
    }
    if (arg === "--port") {
      const next = argv[index + 1]
      if (!next) throw new Error("Missing value for --port")
      port = Number(next)
      index += 1
      continue
    }
    if (arg === "--host") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --host")
      if (isShareEnabled(share)) {
        throwShareConflict(share, "--host")
      }
      host = next
      sawHost = true
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throwShareConflict(share, "--remote")
      }
      host = "0.0.0.0"
      sawRemote = true
      continue
    }
    if (arg === "--share") {
      assertNoHostOverride("--share", sawHost, sawRemote)
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      assertNoHostOverride("--cloudflared", sawHost, sawRemote)
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --cloudflared")
      share = { kind: "token", token: next }
      index += 1
      continue
    }
    if (arg === "--no-open") {
      openBrowser = false
      continue
    }
    if (arg === "--password") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --password")
      password = next
      index += 1
      continue
    }
    if (arg === "--strict-port") {
      strictPort = true
      continue
    }
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`)
  }

  return {
    kind: "run",
    options: {
      port,
      host,
      openBrowser,
      share,
      password,
      strictPort,
    },
  }
}

export function compareVersions(currentVersion: string, latestVersion: string) {
  const currentParts = normalizeVersion(currentVersion)
  const latestParts = normalizeVersion(latestVersion)
  const length = Math.max(currentParts.length, latestParts.length)

  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] ?? 0
    const latest = latestParts[index] ?? 0
    if (current === latest) continue
    return current < latest ? -1 : 1
  }

  return 0
}

function normalizeVersion(version: string) {
  return version
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

export async function runCli(argv: string[], deps: CliRuntimeDeps): Promise<CliRunResult> {
  const parsedArgs = parseArgs(argv)
  if (parsedArgs.kind === "service") {
    try {
      await deps.manageService(parsedArgs.action, parsedArgs.options)
      return { kind: "exited", code: 0 }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.warn(`${LOG_PREFIX} ${message}`)
      return { kind: "exited", code: 1 }
    }
  }
  if (parsedArgs.kind === "version") {
    deps.log(deps.version)
    return { kind: "exited", code: 0 }
  }
  if (parsedArgs.kind === "help") {
    printHelp()
    return { kind: "exited", code: 0 }
  }

  if (compareVersions(deps.bunVersion, MINIMUM_BUN_VERSION) < 0) {
    deps.warn(`${LOG_PREFIX} Bun ${MINIMUM_BUN_VERSION}+ is required for the embedded terminal. Current Bun: ${deps.bunVersion}`)
    return { kind: "exited", code: 1 }
  }

  if (parsedArgs.options.share === "quick" && !parsedArgs.options.password) {
    deps.warn(`${LOG_PREFIX} --share exposes this computer to the public internet and requires --password`)
    return { kind: "exited", code: 1 }
  }

  if (isTokenShareMode(parsedArgs.options.share) && !parsedArgs.options.password) {
    deps.warn(`${LOG_PREFIX} named tunnel has no StillOn password; protect its hostname with Cloudflare Access`)
  }

  const { port, stop } = await deps.startServer({
    ...parsedArgs.options,
    trustProxy: isShareEnabled(parsedArgs.options.share)
      || process.env.STILLON_TRUST_PROXY === "1",
    onMigrationProgress: deps.log,
  })
  const bindHost = parsedArgs.options.host
  const displayHost = isShareEnabled(parsedArgs.options.share) || bindHost === "127.0.0.1" || bindHost === "0.0.0.0" ? "localhost" : bindHost
  const launchUrl = `http://${displayHost}:${port}`
  let shareTunnelStop: (() => void) | null = null

  deps.log(`${LOG_PREFIX} listening on http://${bindHost}:${port}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  if (isShareEnabled(parsedArgs.options.share)) {
    try {
      const shareTunnel = await (deps.startShareTunnel ?? ((localUrl, shareMode) => startShareTunnel(localUrl, shareMode, {
        log: (message) => deps.log(`${LOG_PREFIX} ${message}`),
      })))(launchUrl, parsedArgs.options.share)
      shareTunnelStop = shareTunnel.stop
      if (shareTunnel.publicUrl) {
        await logShareDetails(deps.log, shareTunnel.publicUrl, launchUrl, deps.renderShareQr ?? renderTerminalQr)
      } else {
        deps.warn(`${LOG_PREFIX} named tunnel started but no public hostname was detected`)
        if (isTokenShareMode(parsedArgs.options.share)) {
          deps.warn(`${LOG_PREFIX} use the hostname configured for the provided Cloudflare tunnel token`)
        }
        deps.log("Local URL:")
        deps.log(launchUrl)
      }
    } catch (error) {
      await stop()
      deps.warn(`${LOG_PREFIX} failed to start Cloudflare share tunnel`)
      if (error instanceof Error && error.message) {
        deps.warn(`${LOG_PREFIX} ${error.message}`)
      }
      return { kind: "exited", code: 1 }
    }
  }

  if (parsedArgs.options.openBrowser && !isShareEnabled(parsedArgs.options.share)) {
    deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    stop: async () => {
      shareTunnelStop?.()
      await stop()
    },
  }
}

export function openUrl(url: string) {
  const platform = process.platform
  if (platform === "darwin") {
    void spawnDetached("open", [url]).catch(() => {})
  } else if (platform === "win32") {
    void spawnDetached("explorer.exe", [url]).catch(() => {})
  } else {
    void spawnDetached("xdg-open", [url]).catch(() => {})
  }
  console.log(`${LOG_PREFIX} opened in default browser`)
}
