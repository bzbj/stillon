import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { PROD_SERVER_PORT } from "../../shared/ports"
import { linuxServiceBackend } from "./linux"
import { macosServiceBackend } from "./macos"
import type {
  ServiceAction,
  ServiceBackend,
  ServiceCommandOptions,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceLaunchSpec,
} from "./types"
import { windowsServiceBackend } from "./windows"

export interface ManageServiceOptions {
  platform?: NodeJS.Platform
  executable?: string
  entrypoint?: string
  workingDirectory?: string
  homeDirectory?: string
  pathEnvironment?: string
  localAppDataDirectory?: string
  port?: number
  environmentFile?: string
  run?: ServiceCommandRunner
  log?: (message: string) => void
  warn?: (message: string) => void
  backend?: ServiceBackend
}

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) return new Error(`Failed to start ${command}`)
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  return code === "ENOENT"
    ? new Error(`Command not found: ${command}`)
    : new Error(error.message || `Failed to start ${command}`)
}

export function runServiceCommand(
  command: string,
  args: string[],
  options: ServiceCommandOptions = {},
): Promise<ServiceCommandResult> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (error) => reject(formatSpawnError(command, error)))
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

export function resolveServiceBackend(platform: NodeJS.Platform): ServiceBackend {
  if (platform === "darwin") return macosServiceBackend
  if (platform === "linux") return linuxServiceBackend
  if (platform === "win32") return windowsServiceBackend
  throw new Error(`Background service management is not supported on ${platform}`)
}

export function createServiceLaunchSpec(options: ManageServiceOptions = {}): ServiceLaunchSpec {
  const executable = options.executable ?? process.execPath
  const entrypoint = options.entrypoint ?? process.argv[1]
  if (!entrypoint) {
    throw new Error("Could not determine the StillOn CLI entrypoint for background service installation")
  }

  const port = options.port ?? PROD_SERVER_PORT
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid service port: ${port}`)
  }
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const entrypointPath = path.resolve(entrypoint)
  const entrypointDirectory = path.dirname(entrypointPath)
  // The normal source/runtime layout is <runtime>/bin/stillon. Keep the
  // managed service rooted at <runtime>, never at the caller's shell cwd.
  const defaultWorkingDirectory = path.basename(entrypointDirectory) === "bin"
    ? path.dirname(entrypointDirectory)
    : entrypointDirectory
  const environmentFile = options.environmentFile?.trim()
  if (options.environmentFile !== undefined && !environmentFile) {
    throw new Error("Service environment file path cannot be empty")
  }

  return {
    executable,
    args: [
      ...(environmentFile ? ["--env-file", path.resolve(environmentFile)] : []),
      entrypoint,
      "--no-open",
      "--strict-port",
      "--port",
      String(port),
    ],
    workingDirectory: options.workingDirectory ?? defaultWorkingDirectory,
    homeDirectory,
    pathEnvironment: options.pathEnvironment ?? process.env.PATH ?? "",
    environmentFile: environmentFile ? path.resolve(environmentFile) : undefined,
    localAppDataDirectory: options.localAppDataDirectory ?? process.env.LOCALAPPDATA,
  }
}

export async function manageService(action: ServiceAction, options: ManageServiceOptions = {}) {
  const platform = options.platform ?? process.platform
  const backend = options.backend ?? resolveServiceBackend(platform)
  await backend[action]({
    launch: createServiceLaunchSpec(options),
    run: options.run ?? runServiceCommand,
    log: options.log ?? console.log,
    warn: options.warn ?? console.warn,
  })
}
