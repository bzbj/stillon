import { hostname } from "node:os"
import process from "node:process"
import { spawnSync } from "node:child_process"

export const MAX_MACHINE_NAME_LENGTH = 80

function runAndRead(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

export function normalizeMachineName(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return normalized ? normalized.slice(0, MAX_MACHINE_NAME_LENGTH) : null
}

export function getMachineDisplayName(env: NodeJS.ProcessEnv = process.env) {
  const configuredName = normalizeMachineName(env.STILLON_MACHINE_NAME)
  if (configuredName) {
    return configuredName
  }

  if (process.platform === "darwin") {
    const computerName = runAndRead("scutil", ["--get", "ComputerName"])
    if (computerName) {
      return computerName
    }
  }

  const rawHostname = normalizeMachineName(hostname()) ?? ""
  return rawHostname.replace(/\.local$|\.lan$/i, "") || "This Machine"
}
