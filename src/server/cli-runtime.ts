import process from "node:process"
import { spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX } from "../shared/branding"
import { PROD_SERVER_PORT } from "../shared/ports"
import type { ServiceAction } from "./service/types"

export interface CliOptions {
  port: number
  host: string
  openBrowser: boolean
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
  manageService: (action: ServiceAction, options: {
    port: number
    environmentFile?: string
    host?: string
    trustProxy?: boolean
  }) => Promise<void>
}

type ParsedArgs =
  | { kind: "run"; options: CliOptions; trustProxy?: true }
  | {
    kind: "service"
    action: ServiceAction
    options: { port: number; environmentFile?: string; host?: string; trustProxy?: boolean }
  }
  | { kind: "help" }
  | { kind: "version" }

const MINIMUM_BUN_VERSION = "1.3.5"

function isRemovedTunnelOption(arg: string) {
  return arg === "--share"
    || arg.startsWith("--share=")
    || arg === "--cloudflared"
    || arg.startsWith("--cloudflared=")
}

function removedTunnelOptionError(arg: string): Error {
  const option = arg.startsWith("--cloudflared") ? "--cloudflared" : "--share"
  return new Error(
    `${option} is no longer built in. Use a separately managed reverse proxy or tunnel, or --host/--remote for direct listening.`
  )
}

function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase()
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]"
}

function warnAboutDirectTrustedProxyListener(
  host: string,
  trustProxy: boolean,
  warn: (message: string) => void,
) {
  if (!trustProxy || isLoopbackHost(host)) return
  warn(`${LOG_PREFIX} --trust-proxy is active on a non-loopback listener. Restrict the port so only the trusted proxy can reach it; direct clients can forge forwarded headers.`)
}

function printHelp() {
  console.log(`${APP_NAME} — local-first project chat UI

Usage:
  ${CLI_COMMAND} [options]
  ${CLI_COMMAND} service <install|status|logs|uninstall> [options]

Options:
  --port <number>      Port to listen on (default: ${PROD_SERVER_PORT})
  --host <host>        Bind to a specific host or IP
  --remote             Shortcut for --host 0.0.0.0
  --trust-proxy        Trust forwarded HTTPS metadata from one trusted proxy
  --password <secret>  Optional application password; any non-empty value is accepted
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
  --host <host>        Persist a specific listener address
  --remote             Persist the 0.0.0.0 listener shortcut
  --trust-proxy        Persist trusted-proxy mode (no secret is stored)
  --env-file <path>    Load service-only environment variables from this file

External ingress:
  StillOn starts on 127.0.0.1 by default. Use --host/--remote for a direct
  listener, or point an operator-managed reverse proxy or tunnel at the local
  listener. Use --trust-proxy (or persist it with service install) only for a
  trusted proxy that is the sole route to StillOn.
  StillOn does not provision external access.`)
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
    let host: string | undefined
    let trustProxy = false
    const serviceArgs = argv.slice(2)
    if (action === "install") {
      for (let index = 0; index < serviceArgs.length; index += 1) {
        const arg = serviceArgs[index]
        if (isRemovedTunnelOption(arg)) {
          throw removedTunnelOptionError(arg)
        }
        if (arg === "--remote") {
          host = "0.0.0.0"
          continue
        }
        if (arg === "--trust-proxy") {
          trustProxy = true
          continue
        }
        if (arg === "--port" || arg.startsWith("--port=")) {
          const inlineValue = arg.startsWith("--port=") ? arg.slice("--port=".length) : null
          const value = inlineValue ?? serviceArgs[index + 1]
          if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --port")
          port = Number(value)
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid service port: ${value}`)
          }
          if (inlineValue === null) index += 1
          continue
        }
        if (arg === "--host" || arg.startsWith("--host=")) {
          const inlineValue = arg.startsWith("--host=") ? arg.slice("--host=".length) : null
          const value = inlineValue ?? serviceArgs[index + 1]
          if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --host")
          host = value
          if (inlineValue === null) index += 1
          continue
        }
        if (arg === "--env-file" || arg.startsWith("--env-file=")) {
          const inlineValue = arg.startsWith("--env-file=") ? arg.slice("--env-file=".length) : null
          const value = inlineValue ?? serviceArgs[index + 1]
          if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --env-file")
          environmentFile = value
          if (inlineValue === null) index += 1
          continue
        }
        throw new Error(`Unexpected argument for service install: ${arg}`)
      }
    } else if (serviceArgs.length > 0) {
      throw new Error(`Unexpected argument for service ${action}: ${serviceArgs[0]}`)
    }

    return {
      kind: "service",
      action,
      options: {
        port,
        ...(environmentFile ? { environmentFile } : {}),
        ...(host ? { host } : {}),
        ...(trustProxy ? { trustProxy: true } : {}),
      },
    }
  }

  let port = PROD_SERVER_PORT
  let host = "127.0.0.1"
  let openBrowser = true
  let password: string | null = null
  let strictPort = false
  let trustProxy = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (isRemovedTunnelOption(arg)) {
      throw removedTunnelOptionError(arg)
    }
    if (arg === "--version" || arg === "-v") {
      return { kind: "version" }
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" }
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const inlineValue = arg.startsWith("--port=") ? arg.slice("--port=".length) : null
      const next = argv[index + 1]
      const value = inlineValue ?? next
      if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --port")
      port = Number(value)
      if (inlineValue === null) index += 1
      continue
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const inlineValue = arg.startsWith("--host=") ? arg.slice("--host=".length) : null
      const next = argv[index + 1]
      const value = inlineValue ?? next
      if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --host")
      host = value
      if (inlineValue === null) index += 1
      continue
    }
    if (arg === "--remote") {
      host = "0.0.0.0"
      continue
    }
    if (arg === "--trust-proxy") {
      trustProxy = true
      continue
    }
    if (arg === "--no-open") {
      openBrowser = false
      continue
    }
    if (arg === "--password" || arg.startsWith("--password=")) {
      const inlineValue = arg.startsWith("--password=") ? arg.slice("--password=".length) : null
      const next = argv[index + 1]
      const value = inlineValue ?? next
      if (!value || (inlineValue === null && value.startsWith("-"))) throw new Error("Missing value for --password")
      password = value
      if (inlineValue === null) index += 1
      continue
    }
    if (arg === "--strict-port") {
      strictPort = true
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    throw new Error(`Unexpected positional argument: ${arg}`)
  }

  return {
    kind: "run",
    options: {
      port,
      host,
      openBrowser,
      password,
      strictPort,
    },
    ...(trustProxy ? { trustProxy: true as const } : {}),
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
  let parsedArgs: ParsedArgs
  try {
    parsedArgs = parseArgs(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.warn(`${LOG_PREFIX} ${message}`)
    return { kind: "exited", code: 1 }
  }
  if (parsedArgs.kind === "service") {
    if (parsedArgs.action === "install") {
      warnAboutDirectTrustedProxyListener(
        parsedArgs.options.host ?? "127.0.0.1",
        parsedArgs.options.trustProxy === true,
        deps.warn,
      )
    }
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

  const trustProxy = parsedArgs.trustProxy === true || process.env.STILLON_TRUST_PROXY === "1"
  warnAboutDirectTrustedProxyListener(parsedArgs.options.host, trustProxy, deps.warn)

  if (!isLoopbackHost(parsedArgs.options.host) && !parsedArgs.options.password) {
    deps.warn(`${LOG_PREFIX} this listener is not loopback-only and has no application password. Protect it with an appropriate ingress authentication policy.`)
  }

  const { port, stop } = await deps.startServer({
    ...parsedArgs.options,
    trustProxy,
    onMigrationProgress: deps.log,
  })
  const bindHost = parsedArgs.options.host
  const displayHost = bindHost === "127.0.0.1" || bindHost === "0.0.0.0" ? "localhost" : bindHost
  const launchUrl = `http://${displayHost}:${port}`

  deps.log(`${LOG_PREFIX} listening on http://${bindHost}:${port}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  if (parsedArgs.options.openBrowser) {
    deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    stop: async () => {
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
