import { homedir } from "node:os"

interface ClaudeExecutableOptions {
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export function resolveClaudeCodeExecutable({
  environment = process.env,
  homeDirectory = homedir(),
}: ClaudeExecutableOptions = {}): string | undefined {
  const configured = environment.CLAUDE_EXECUTABLE?.trim()
  if (!configured) return undefined
  return configured.replace(/^~(?=$|[\\/])/, homeDirectory)
}

export function getClaudeCliCommand({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
}: ClaudeExecutableOptions = {}) {
  return resolveClaudeCodeExecutable({ environment, homeDirectory })
    ?? (platform === "win32" ? "claude.cmd" : "claude")
}
