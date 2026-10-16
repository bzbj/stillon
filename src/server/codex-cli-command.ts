import { homedir } from "node:os"
import { findCliExecutable } from "./cli-environment"

export function getCodexCliCommand(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.CODEX_EXECUTABLE?.trim()
  if (configured) return configured.replace(/^~(?=$|[\\/])/u, environment.HOME ?? environment.USERPROFILE ?? homedir())
  return findCliExecutable("codex", environment, platform) ?? (platform === "win32" ? "codex.cmd" : "codex")
}
