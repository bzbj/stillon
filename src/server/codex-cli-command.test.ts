import { describe, expect, test } from "bun:test"
import { getCodexCliCommand } from "./codex-cli-command"
import { CODEX_APP_EXECUTABLE, codexAppCliCandidates, windowsCodexAppCliCandidates } from "./codex-app-cli"

describe("getCodexCliCommand", () => {
  test("keeps a platform fallback when discovery has no environment", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(getCodexCliCommand(platform, {}, () => undefined)).toBe(platform === "win32" ? "codex.cmd" : "codex")
    }
  })

  test("macOS checks user and system ChatGPT/Codex bundles before PATH", () => {
    const environment = { HOME: "/Users/example", PATH: "/standalone" }
    const candidates = codexAppCliCandidates("darwin", environment)
    expect(candidates).toEqual([
      "/Users/example/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Users/example/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ])
    for (const app of candidates) {
      const find = (command: string) => command === app ? app : command === "codex" ? "/standalone/codex" : undefined
      expect(getCodexCliCommand("darwin", environment, find)).toBe(app)
      expect(getCodexCliCommand("darwin", { ...environment, CODEX_EXECUTABLE: "~/chosen/codex" }, find)).toBe("/Users/example/chosen/codex")
    }
    expect(getCodexCliCommand("darwin", environment, command => command === "codex" ? "/standalone/codex" : undefined)).toBe("/standalone/codex")
    expect(codexAppCliCandidates("linux", environment)).toEqual([])
  })

  test("Windows shares the discovered app executable and respects explicit overrides", () => {
    const app = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_test\\app\\resources\\codex.exe"
    const environment = { [CODEX_APP_EXECUTABLE]: app }
    const find = (command: string) => command === app ? app : command === "codex" ? "C:\\Tools\\codex.cmd" : undefined
    expect(getCodexCliCommand("win32", environment, find)).toBe(app)
    expect(getCodexCliCommand("win32", { ...environment, CODEX_EXECUTABLE: "C:\\Chosen\\codex.exe" }, find)).toBe("C:\\Chosen\\codex.exe")
    expect(getCodexCliCommand("win32", environment, command => command === "codex" ? "C:\\Tools\\codex.cmd" : undefined)).toBe("C:\\Tools\\codex.cmd")
  })

  test("Windows queries current-user registration and never selects the GUI launcher", async () => {
    const locations = ["C:\\Program Files\\WindowsApps\\OpenAI.Codex_new", "C:\\Program Files\\WindowsApps\\OpenAI.Codex_old"]
    const read = async (command: string, args: string[]) => {
      expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      const script = args.at(-1)!
      expect(script).toContain("Get-AppxPackage -Name 'OpenAI.Codex'")
      expect(script).toContain("Sort-Object Version -Descending")
      expect(script).not.toContain("-AllUsers")
      return JSON.stringify(locations)
    }
    const candidates = await windowsCodexAppCliCandidates({}, read)
    expect(candidates).toEqual(locations.flatMap(location => [`${location}\\app\\resources\\codex.exe`, `${location}\\resources\\codex.exe`]))
    for (const location of locations) expect(candidates).not.toContain(`${location}\\Codex.exe`)
    expect(await windowsCodexAppCliCandidates({}, async () => "\uFEFF" + JSON.stringify(locations[0]))).toEqual(candidates.slice(0, 2))
    for (const output of ["", "not json", "null", "{}", '["relative",42,"C:\\\\bad\\npath"]']) {
      expect(await windowsCodexAppCliCandidates({}, async () => output)).toEqual([])
    }
    expect(await windowsCodexAppCliCandidates({}, async () => { throw new Error("PowerShell unavailable or timed out") })).toEqual([])
  })
})
