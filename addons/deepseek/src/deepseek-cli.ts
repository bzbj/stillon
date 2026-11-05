import { execFile, spawn } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { findCliExecutable } from "../../../src/server/cli-environment"

const exec = promisify(execFile)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

// The Mac preview uses the public release with SDK question/approval bridging.
export const deepSeekCliVersion = (platform: NodeJS.Platform = process.platform) => platform === "darwin" ? "0.2.2-rc.1" : "0.2.1-rc.5"

/** Launch the documented CLI, including Desktop's public Windows shim. */
export function deepSeekCommand(executable: string, args: string[], environment: NodeJS.ProcessEnv, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat|ps1)$/iu.test(executable)) {
    const script = `& ${[executable, ...args].map(quote).join(" ")}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
    return {
      command: path.win32.join(environment.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    }
  }
  return { command: executable, args }
}

export function deepSeekCandidates(environment: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix
  const home = environment.USERPROFILE ?? environment.HOME ?? homedir()
  if (environment.DSH_EXECUTABLE) return [environment.DSH_EXECUTABLE]
  const candidates = [findCliExecutable("dsh", environment, platform)].filter((value): value is string => Boolean(value))
  if (platform === "win32") {
    const roots = [p.join(environment.LOCALAPPDATA ?? p.join(home, "AppData/Local"), "Programs"), environment.ProgramFiles, environment["ProgramFiles(x86)"]]
    for (const root of roots) if (root) candidates.push(p.join(root, "DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"))
  } else if (platform === "darwin") {
    for (const root of ["/Applications", p.join(home, "Applications")]) candidates.push(p.join(root, "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"))
  }
  return candidates
}

/** Explicit choice wins, then PATH, Windows install metadata, and standard locations. */
export async function discoverDeepSeek(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates = deepSeekCandidates(environment)
  if (environment.DSH_EXECUTABLE) {
    if (findCliExecutable(candidates[0]!, environment)) return candidates[0]!
    throw new Error("The configured DeepSeek CLI is missing. Select its public dsh launcher in Agent setup.")
  }
  const fromPath = findCliExecutable("dsh", environment)
  if (fromPath) return fromPath
  if (process.platform === "win32") {
    const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) { foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) { $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view); $apps = $root.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); if ($apps) { foreach ($name in $apps.GetSubKeyNames()) { $app = $apps.OpenSubKey($name); if ($app.GetValue('DisplayName') -like '*DeepSeek*') { $location = $app.GetValue('InstallLocation'); if ($location) { [Console]::WriteLine([IO.Path]::Combine($location,'resources\\runtime\\cli\\bin\\dsh.cmd')) } }; $app.Dispose() }; $apps.Dispose() }; $root.Dispose() } }`
    try {
      const command = deepSeekCommand("unused.cmd", [], environment).command
      const output = await exec(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: environment, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 })
      candidates.unshift(...output.stdout.split(/\r?\n/u).filter(Boolean))
    } catch { /* Standard locations remain available without registry access. */ }
  }
  for (const candidate of candidates) if (findCliExecutable(candidate, environment)) return candidate
  throw new Error("DeepSeek Harness was not found. Install the desktop app or select its public dsh executable in Agent setup.")
}

export async function deepSeekVersion(executable: string, environment: NodeJS.ProcessEnv) {
  const launch = deepSeekCommand(executable, ["--version"], environment)
  const pending = exec(launch.command, launch.args, { env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 })
  const output = await pending.catch(async error => {
    if (pending.child.pid && error.killed) await killDeepSeekTree(pending.child.pid, false).catch(() => undefined)
    throw new Error("The selected DeepSeek CLI could not report its version. Check or repair its installation.")
  })
  const version = output.stdout.trim()
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) throw new Error("The selected executable did not identify itself as dsh.")
  return version
}

export function spawnDeepSeek(executable: string, cwd: string, environment: NodeJS.ProcessEnv, extra: string[] = []) {
  const launch = deepSeekCommand(executable, ["--profile", "sdk", ...extra], environment)
  return spawn(launch.command, launch.args, { env: environment, cwd, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] })
}

export async function killDeepSeekTree(pid: number, processGroup = true) {
  if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 })
  else process.kill(processGroup ? -pid : pid, "SIGKILL")
}
