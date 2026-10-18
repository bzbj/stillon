import { homedir } from "node:os"
import { findCliExecutable } from "./cli-environment"
import { codexAppCliCandidates } from "./codex-app-cli"

export function getCodexCliCommand(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, findExecutable = findCliExecutable) {
  const configured = environment.CODEX_EXECUTABLE?.trim()
  if (configured) return configured.replace(/^~(?=$|[\\/])/u, environment.HOME ?? environment.USERPROFILE ?? homedir())
  for (const candidate of codexAppCliCandidates(platform, environment)) {
    const executable = findExecutable(candidate, environment, platform)
    if (executable) return executable
  }
  return findExecutable("codex", environment, platform) ?? (platform === "win32" ? "codex.cmd" : "codex")
}
