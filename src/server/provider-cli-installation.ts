import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { AgentProvider } from "../shared/types"
import { findCliExecutable } from "./cli-environment"
import { getCodexCliCommand } from "./codex-cli-command"
import { getClaudeCliCommand } from "./claude-executable"

const exec = promisify(execFile)
export const cliPackages = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" } as const
export const cliVersion = (output: string) => output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/u)?.[0]
export const stableCliVersion = (version: string) => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(version)
export function newerCliVersion(candidate: string, installed: string) {
  if (!stableCliVersion(candidate) || !stableCliVersion(installed)) return false
  const a = candidate.split(".").map(Number), b = installed.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

export type CliRunner = (command: string, args: string[], environment: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<string>
export const runCli: CliRunner = async (command, args, env, timeout = 10_000) => {
  // .cmd/.bat cannot be passed directly to CreateProcess. PowerShell quotes
  // literal arguments; never feed installation paths to cmd.exe or a shell string.
  if (process.platform === "win32" && /\.(cmd|bat)$/iu.test(command)) {
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
    const script = `& ${[command, ...args].map(quote).join(" ")}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
    command = path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
  }
  const result = await exec(command, args, { env, windowsHide: true, cwd: env.HOME || env.USERPROFILE || homedir(), timeout, maxBuffer: 1024 * 1024 })
  return result.stdout
}

export interface CliInstallation {
  executable?: string
  version?: string
  identity: string
  label: string
  automaticUpdates: string
  reason?: string
  method?: { kind: "npm"; prefix: string } | { kind: "native"; binDir: string }
}
const exists = async (file: string) => !!await stat(file).catch(() => null)
const json = async (file: string): Promise<any> => JSON.parse(await readFile(file, "utf8"))

/** Resolve the same command as the agent. Never search for a newer alternative. */
export async function inspectCliInstallation(provider: AgentProvider, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, runner: CliRunner = runCli): Promise<CliInstallation> {
  const p = platform === "win32" ? path.win32 : path.posix
  const home = env.HOME || env.USERPROFILE || homedir()
  const command = provider === "codex" ? getCodexCliCommand(platform, env) : getClaudeCliCommand({ platform, environment: env })
  const executable = findCliExecutable(command, env, platform)
  const base: CliInstallation = { executable: executable ?? undefined, identity: "missing", label: "Not installed", automaticUpdates: "Managed outside StillOn." }
  if (!executable) return { ...base, reason: "Install the CLI from Get Started, then check again." }
  const actual = await realpath(executable).catch(() => executable)
  const info = await stat(actual).catch(() => null)
  base.identity = JSON.stringify([executable, actual, info?.size, info?.mtimeMs])
  const appManaged = /\.app[\\/]|[\\/]WindowsApps[\\/]/iu.test(actual)
  base.label = appManaged ? "App-managed component" : "External installation"
  try { base.version = cliVersion(await runner(executable, ["--version"], env)) } catch { /* actionable status below */ }
  if (appManaged) return { ...base, reason: "Update this component through its desktop app." }
  if (!base.version) return { ...base, reason: "This CLI could not be checked. Repair the installation or check its configured path." }
  if (!stableCliVersion(base.version)) return { ...base, reason: "This CLI uses a preview version. Manage preview updates with its installer." }
  // A package manifest alone is insufficient: verify that the selected command
  // is this package's bin or a shim pointing at it, and preserve its global prefix.
  const candidates = new Set<string>()
  let parent = p.dirname(actual)
  for (let i = 0; i < 12; i++) { candidates.add(parent); const next = p.dirname(parent); if (next === parent) break; parent = next }
  candidates.add(p.join(p.dirname(executable), "node_modules", cliPackages[provider]))
  for (const directory of candidates) {
    const manifest = await json(p.join(directory, "package.json")).catch(() => null)
    if (manifest?.name !== cliPackages[provider]) continue
    const marker = `${p.sep}node_modules${p.sep}${cliPackages[provider].replaceAll("/", p.sep)}`
    if (!directory.endsWith(marker)) continue
    let prefix = directory.slice(0, -marker.length)
    if (platform !== "win32") { if (p.basename(prefix) !== "lib") continue; prefix = p.dirname(prefix) }
    if (/[\\/]\.bun[\\/]|[\\/]\.bun$/u.test(prefix)) continue
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[provider]
    if (typeof bin !== "string") continue
    const binPath = await realpath(p.resolve(directory, bin)).catch(() => "")
    const shim = /\.(cmd|ps1|bat)$/iu.test(executable) ? await readFile(executable, "utf8").catch(() => "") : ""
    if (actual !== binPath && !shim.replaceAll("\\", "/").includes(`node_modules/${cliPackages[provider]}/`)) continue
    return { ...base, label: "npm", method: { kind: "npm", prefix }, automaticUpdates: "npm does not update this CLI automatically." }
  }
  const nativeBin = provider === "codex" && platform === "win32"
    ? p.join(env.LOCALAPPDATA || p.join(home, "AppData/Local"), "Programs/OpenAI/Codex/bin") : p.join(home, ".local/bin")
  const expected = p.join(nativeBin, `${provider}${platform === "win32" ? ".exe" : ""}`)
  const equal = (a: string, b: string) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
  if (equal(executable, expected)) {
    const nativeRoot = provider === "codex" ? p.join(env.CODEX_HOME || p.join(home, ".codex"), "packages/standalone") : p.join(home, ".local/share/claude/versions")
    if (await exists(nativeRoot)) {
      let automaticUpdates = "CLI auto-update state could not be determined. StillOn only updates on request."
      if (provider === "claude") {
        const settings = await json(p.join(env.CLAUDE_CONFIG_DIR || p.join(home, ".claude"), "settings.json")).catch(() => ({}))
        const disabled = env.DISABLE_AUTOUPDATER || settings.env?.DISABLE_AUTOUPDATER
        automaticUpdates = disabled === "1" ? "Claude background updates are disabled by DISABLE_AUTOUPDATER."
          : `Claude's native installer enables background updates (${settings.autoUpdatesChannel === "stable" ? "stable" : "latest"} channel); policy may override this.`
      } else if (await exists(p.join(nativeRoot, "auto-update-version"))) automaticUpdates = "Codex native installer has its own auto-update selection. Managed outside StillOn."
      return { ...base, label: "Native installer", method: { kind: "native", binDir: nativeBin }, automaticUpdates }
    }
  }
  return { ...base, reason: "This installation is managed by another tool or uses a custom path. Update it with its original installer, then check again." }
}

/** Locate npm itself; run npm-cli.js with Node, avoiding shell command parsing. */
export async function npmUpdateCommand(env: NodeJS.ProcessEnv, prefix: string, provider: AgentProvider, version: string) {
  if (!stableCliVersion(version)) throw new Error("Invalid release version.")
  const npm = findCliExecutable("npm", env), node = findCliExecutable("node", env)
  if (!npm || !node) throw new Error("Node.js and npm must be available to update this npm installation.")
  const resolved = await realpath(npm)
  const script = process.platform === "win32" ? path.join(path.dirname(npm), "node_modules/npm/bin/npm-cli.js") : resolved
  if (!await exists(script) || !script.endsWith(`${path.sep}npm-cli.js`)) throw new Error("Could not locate the existing npm installer. Update using the original package manager.")
  return { command: node, args: [script, "install", "--global", "--prefix", prefix, `${cliPackages[provider]}@${version}`, "--no-audit", "--no-fund"] }
}
