import { homedir } from "node:os"
import path from "node:path"

/** Internal discovery snapshot, separate from the user's CODEX_EXECUTABLE override. */
export const CODEX_APP_EXECUTABLE = "STILLON_CODEX_APP_EXECUTABLE"

export function codexAppCliCandidates(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  if (platform === "darwin") {
    const home = environment.HOME ?? homedir()
    return [path.posix.join(home, "Applications"), "/Applications"].flatMap(directory =>
      ["ChatGPT.app", "Codex.app"].map(app => path.posix.join(directory, app, "Contents", "Resources", "codex")))
  }
  if (platform === "win32" && environment[CODEX_APP_EXECUTABLE]) return [environment[CODEX_APP_EXECUTABLE]!]
  return []
}

export type EnvironmentReader = (command: string, args: string[], environment: NodeJS.ProcessEnv) => Promise<string>

export function windowsPowerShell(environment: NodeJS.ProcessEnv) {
  return path.win32.join(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

/** Query only the current user's registered package; no elevation or WindowsApps scan. */
export async function windowsCodexAppCliCandidates(environment: NodeJS.ProcessEnv, read: EnvironmentReader) {
  try {
    const output = await read(windowsPowerShell(environment), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation | ConvertTo-Json -Compress"], environment)
    if (!output.trim()) return []
    const locations: unknown = JSON.parse(output.replace(/^\uFEFF/u, ""))
    return (Array.isArray(locations) ? locations : [locations])
      .filter((location): location is string => typeof location === "string" && path.win32.isAbsolute(location) && !/[\u0000\r\n]/u.test(location))
      // The package's top-level Codex.exe launches the GUI, not the CLI.
      .flatMap(location => [path.win32.join(location, "app", "resources", "codex.exe"), path.win32.join(location, "resources", "codex.exe")])
  } catch { return [] }
}
