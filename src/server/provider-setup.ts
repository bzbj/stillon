import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { AgentProvider } from "../shared/types"
import type { ProviderSetupStatus } from "../shared/provider-setup"
import { findCliExecutable } from "./cli-environment"
import { getCodexCliCommand } from "./codex-cli-command"
import { getClaudeCliCommand } from "./claude-executable"

const exec = promisify(execFile)
type Runner = (command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>
const run: Runner = async (command, args, env) => {
  try { const result = await exec(command, args, { env, cwd: env.HOME ?? env.USERPROFILE ?? homedir(), timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }); return { code: 0, stdout: result.stdout } }
  catch (error) {
    const result = error as { code?: string | number; stdout?: string }
    if (result.code === 1) return { code: 1, stdout: result.stdout ?? "" }
    throw new Error("The CLI could not be checked. Verify its path or recheck after fixing the installation.")
  }
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
const keptEnvironment = /^(PATH|HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/u

export function providerTerminalScript(options: { platform: NodeJS.Platform; environment: NodeJS.ProcessEnv; executable?: string; provider: AgentProvider; action: "login" | "install" }) {
  const { platform, environment, provider, action } = options
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir()
  const vars = Object.entries(environment).filter(([key, value]) => keptEnvironment.test(key) && value !== undefined)
  if (vars.some(([, value]) => value!.includes("\0"))) throw new Error("The CLI environment contains an invalid value.")
  const args = provider === "codex" ? ["login"] : ["auth", "login"]
  const message = "Return to StillOn and click Check sign-in or Recheck installation."
  if (platform === "win32") {
    const command = action === "install"
      ? `irm https://${provider === "codex" ? "chatgpt.com/codex" : "claude.ai"}/install.ps1 | iex`
      : `& ${psQuote(options.executable!)} ${args.map(psQuote).join(" ")}`
    return ["$ErrorActionPreference = 'Stop'", "Remove-Item -LiteralPath $PSCommandPath -Force", ...vars.map(([key, value]) => `$env:${key} = ${psQuote(value!)}`), `Set-Location -LiteralPath ${psQuote(home)}`, command, `Write-Host ${psQuote(message)}`].join("\r\n")
  }
  const command = action === "install"
    ? provider === "codex" ? "curl -fsSL https://chatgpt.com/codex/install.sh | sh" : "curl -fsSL https://claude.ai/install.sh | bash"
    : `${shellQuote(options.executable!)} ${args.map(shellQuote).join(" ")}`
  return ["#!/bin/sh", 'rm -- "$0"', ...vars.map(([key, value]) => `export ${key}=${shellQuote(value!)}`), `cd ${shellQuote(home)} || exit 1`, command, "result=$?", `printf '\\n%s\\n' ${shellQuote(message)}`, "printf 'Press Enter to close this window. '; read -r answer", 'exit "$result"'].join("\n") + "\n"
}

export function createProviderSetup(options: {
  dataDir: string; getEnvironment: () => Promise<NodeJS.ProcessEnv>; platform?: NodeJS.Platform
  run?: Runner; launch?: (command: string, args: string[]) => Promise<void>
}) {
  const platform = options.platform ?? process.platform
  const runner = options.run ?? run
  const launch = options.launch ?? (async (command, args) => { await exec(command, args, { windowsHide: true, timeout: 10_000 }) })
  const executable = (provider: AgentProvider, environment: NodeJS.ProcessEnv) => findCliExecutable(provider === "codex" ? getCodexCliCommand(platform, environment) : getClaudeCliCommand({ platform, environment }), environment, platform)
  async function status(provider: AgentProvider, canOpenTerminal: boolean): Promise<ProviderSetupStatus> {
    const environment = await options.getEnvironment()
    const cli = executable(provider, environment)
    const base = { provider, platform, canOpenTerminal: canOpenTerminal && ["win32", "darwin"].includes(platform) }
    if (!cli) return { ...base, state: "missing", installed: false }
    try {
      const version = await runner(cli, ["--version"], environment)
      if (version.code !== 0) throw new Error("The existing CLI cannot start. Repair its installation or select another executable.")
      const auth = await runner(cli, provider === "codex" ? ["login", "status"] : ["auth", "status"], environment)
      return { ...base, installed: true, executable: cli, version: version.stdout.trim().slice(0, 120), state: auth.code === 0 ? "ready" : "signed-out" }
    } catch (error) { return { ...base, installed: true, executable: cli, state: "error", message: error instanceof Error ? error.message : "Could not check this CLI." } }
  }
  async function openTerminal(provider: AgentProvider, action: "login" | "install") {
    if (!["darwin", "win32"].includes(platform)) throw new Error("Open a local terminal on this computer and follow the official CLI guide.")
    const environment = await options.getEnvironment()
    const cli = executable(provider, environment)
    if (action === "install" && cli) throw new Error("An existing CLI was found. Recheck it or sign in instead of reinstalling.")
    if (action === "login" && !cli) throw new Error("CLI not found. Recheck the existing installation before signing in.")
    const directory = path.join(options.dataDir, "setup")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = path.join(directory, `${randomUUID()}.${platform === "win32" ? "ps1" : "command"}`)
    await writeFile(file, (platform === "win32" ? "\uFEFF" : "") + providerTerminalScript({ platform, environment, executable: cli, provider, action }), { mode: 0o700 })
    try {
      if (platform === "darwin") { await chmod(file, 0o700); await launch("/usr/bin/open", ["-a", "Terminal", file]) }
      else {
        const shell = path.win32.join(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        const script = `Start-Process -FilePath ${psQuote(shell)} -WindowStyle Normal -ArgumentList ${psQuote(`-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "${file}"`)}`
        await launch(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")])
      }
    } catch (error) { await unlink(file).catch(() => {}); throw error }
    return { opened: true }
  }
  return { status, openTerminal }
}
