import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import path from "node:path"
import process from "node:process"

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`Failed to start ${command}`)
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "ENOENT") {
    return new Error(`Command not found: ${command}`)
  }

  return new Error(error.message || `Failed to start ${command}`)
}

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    const handleError = (error: Error) => {
      reject(formatSpawnError(command, error))
    }

    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resolve()
    })
  })
}

export function hasCommand(command: string) {
  if (!command || command.includes("\0")) return false

  const isExecutableFile = (filePath: string) => {
    try {
      accessSync(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
      return statSync(filePath).isFile()
    } catch {
      return false
    }
  }

  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(path.resolve(command))
  }

  const pathValue = Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? ""
  const pathSeparator = process.platform === "win32" ? ";" : ":"
  const extensions = process.platform === "win32" && path.extname(command) === ""
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""]

  for (const directory of pathValue.split(pathSeparator)) {
    const baseDirectory = directory || process.cwd()
    for (const extension of extensions) {
      if (isExecutableFile(path.join(baseDirectory, `${command}${extension}`))) {
        return true
      }
    }
  }

  return false
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
