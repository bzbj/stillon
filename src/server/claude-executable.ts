import { homedir } from "node:os"
import { findCliExecutable } from "./cli-environment"

interface ClaudeExecutableOptions {
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export function resolveClaudeCodeExecutable({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
}: ClaudeExecutableOptions = {}): string | undefined {
  const configured = environment.CLAUDE_EXECUTABLE?.trim()
  if (!configured) return findCliExecutable("claude", environment, platform)
  return configured.replace(/^~(?=$|[\\/])/, homeDirectory)
}

export function getClaudeCliCommand({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
}: ClaudeExecutableOptions = {}) {
  return resolveClaudeCodeExecutable({ environment, homeDirectory, platform })
    ?? findCliExecutable("claude", environment, platform) ?? (platform === "win32" ? "claude.cmd" : "claude")
}
