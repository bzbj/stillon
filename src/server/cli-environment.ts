import { execFile } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

export function environmentPath(environment: NodeJS.ProcessEnv) {
  return environment.PATH ?? Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? ""
}

export function mergeSearchPaths(platform: NodeJS.Platform, ...values: string[]) {
  const separator = platform === "win32" ? ";" : ":"
  const seen = new Set<string>()
  return values.flatMap(value => value.split(separator)).map(value => value.trim()).filter(value => {
    if (!value) return false
    const key = platform === "win32" ? value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase() : value
    if (seen.has(key)) return false
    seen.add(key); return true
  }).join(separator)
}

export function cliFallbackPath(home: string, platform: NodeJS.Platform) {
  const p = platform === "win32" ? path.win32 : path.posix
  return (platform === "win32"
    ? [p.join(home, ".local", "bin"), p.join(home, "AppData", "Roaming", "npm"), p.join(home, ".bun", "bin")]
    : [p.join(home, ".local", "bin"), p.join(home, ".bun", "bin"), p.join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    .join(platform === "win32" ? ";" : ":")
}

export function withEnvironmentPath(environment: NodeJS.ProcessEnv, value: string) {
  const result = { ...environment }
  for (const key of Object.keys(result)) if (key.toUpperCase() === "PATH") delete result[key]
  result.PATH = value
  return result
}

export function findCliExecutable(command: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix
  const executable = (file: string) => {
    try { accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(file).isFile() }
    catch { return false }
  }
  if (/[\\/]/u.test(command)) return executable(command) ? command : undefined
  const names = platform === "win32" && !p.extname(command) ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command]
  // Directory order wins before extension preference, matching the user's PATH.
  for (const directory of environmentPath(environment).split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const name of names) {
      const file = p.join(directory.replace(/^"|"$/gu, ""), name)
      if (executable(file)) return file
    }
  }
  return undefined
}

const exec = promisify(execFile)
type PathReader = (command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<string>
const runPathReader: PathReader = async (command, args, environment) => (await exec(command, args, {
  env: environment, timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true,
})).stdout

export async function refreshCliEnvironment(options: {
  environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readPath?: PathReader; home?: string
} = {}) {
  const environment = options.environment ?? process.env, platform = options.platform ?? process.platform
  const home = options.home ?? environment.HOME ?? environment.USERPROFILE ?? homedir()
  let currentPath = ""
  if (!environment.STILLON_AGENT_PATH) {
    try {
      const read = options.readPath ?? runPathReader
      if (platform === "win32") {
        const shell = path.win32.join(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        currentPath = (await read(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))"], environment)).trim()
      } else if (platform === "darwin") {
        const shell = environment.SHELL || userInfo().shell || "/bin/zsh"
        const fish = path.basename(shell) === "fish"
        const output = await read(shell, ["-ilc", fish ? "printf '\\n__STILLON_PATH__%s\\n' (string join : $PATH)" : "printf '\\n__STILLON_PATH__%s\\n' \"$PATH\""], environment)
        currentPath = output.split(/\r?\n/u).find(line => line.startsWith("__STILLON_PATH__"))?.slice("__STILLON_PATH__".length) ?? ""
      }
    } catch { /* Keep inherited locations and known directories when the shell is unavailable. */ }
  }
  return withEnvironmentPath(environment, mergeSearchPaths(platform,
    environment.STILLON_AGENT_PATH || currentPath, environmentPath(environment), environment.STILLON_FALLBACK_PATH ?? "", cliFallbackPath(home, platform)))
}

export function createCliEnvironment(environment: () => NodeJS.ProcessEnv = () => process.env) {
  let resolvedPath: string | undefined
  let pending: Promise<NodeJS.ProcessEnv> | undefined
  return {
    get() { const env = environment(); return withEnvironmentPath(env, resolvedPath ?? mergeSearchPaths(process.platform, environmentPath(env), cliFallbackPath(env.HOME ?? env.USERPROFILE ?? homedir(), process.platform))) },
    refresh() {
      pending ??= refreshCliEnvironment({ environment: environment() }).then(env => { resolvedPath = env.PATH; return env }).finally(() => { pending = undefined })
      return pending
    },
  }
}

/** Scheduled tasks refresh the current registry PATH rather than installing a frozen copy. */
export function windowsUserPathScript(fallback: string) {
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`
  return [
    "$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    `$pathValues = [Environment]::ExpandEnvironmentVariables((@($machinePath, $userPath, $env:Path, ${ps(fallback)}) | Where-Object { $_ }) -join ';')`,
    "$pathSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
    "$env:Path = (($pathValues -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $pathSeen.Add($_) }) -join ';'",
  ].join("\r\n")
}
