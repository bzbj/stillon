import process from "node:process"
import { hostname as getHostname } from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import { LOG_PREFIX } from "../src/shared/branding"
import { parseDevArgs } from "../src/shared/dev-ports"

const cwd = process.cwd()
const forwardedArgs = process.argv.slice(2)
const bunBin = process.execPath
const localHostname = getHostname()
const devArgs = (() => {
  try {
    return parseDevArgs(forwardedArgs, localHostname)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`${LOG_PREFIX} ${message}`)
    process.exit(1)
  }
})()
const { clientPort, serverPort, serverArgs, clientHost } = devArgs

const clientEnv = {
  ...process.env,
  STILLON_DEV_ALLOWED_HOSTS: typeof devArgs.allowedHosts === "boolean"
    ? String(devArgs.allowedHosts)
    : JSON.stringify(devArgs.allowedHosts),
  STILLON_DEV_BACKEND_TARGET_HOST: devArgs.backendTargetHost,
  STILLON_DEV_BACKEND_PORT: String(serverPort),
}

function spawnLabeledProcess(label: string, args: string[]) {
  const child = spawn(bunBin, args, {
    cwd,
    stdio: "inherit",
    env: label === "client" ? clientEnv : process.env,
  })

  child.on("spawn", () => {
    console.log(`${LOG_PREFIX.replaceAll("]", `:${label}]`)} started`)
  })

  return child
}

const client = spawnLabeledProcess("client", ["./node_modules/vite/bin/vite.js", "--host", clientHost, "--port", String(clientPort), "--strictPort"])
const server = spawn(bunBin, ["run", "./scripts/dev-server.ts", "--no-open", "--port", String(serverPort), "--strict-port", ...serverArgs], {
  cwd,
  stdio: "inherit",
  env: process.env,
})

server.on("spawn", () => {
  console.log(`${LOG_PREFIX.replaceAll("]", ":server]")} started`)
})

const children = [client, server]
let shuttingDown = false

function stopChild(child: ChildProcess) {
  if (child.killed || child.exitCode !== null) return
  child.kill("SIGTERM")
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    stopChild(child)
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL")
      }
    }
  }, 2_000).unref()

  process.exit(exitCode)
}

function onChildExit(label: string, code: number | null, signal: NodeJS.Signals | null) {
  if (shuttingDown) return
  const exitCode = code ?? (signal ? 1 : 0)
  console.error(`${LOG_PREFIX.replaceAll("]", `:${label}]`)} exited${signal ? ` via ${signal}` : ` with code ${String(exitCode)}`}`)
  shutdown(exitCode)
}

client.on("exit", (code, signal) => {
  onChildExit("client", code, signal)
})

server.on("exit", (code, signal) => {
  onChildExit("server", code, signal)
})

process.on("SIGINT", () => {
  shutdown(0)
})

process.on("SIGTERM", () => {
  shutdown(0)
})

console.log(`${LOG_PREFIX} dev client: http://${clientHost === "0.0.0.0" ? "localhost" : clientHost}:${clientPort}`)
console.log(`${LOG_PREFIX} dev server: http://${devArgs.backendTargetHost}:${serverPort}`)
