import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProviderSetup, providerTerminalScript } from "./provider-setup"
import { ProviderCliSettings } from "./provider-cli-settings"
import { handleProviderSetupRequest } from "./provider-setup-http"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stillon signin ' "))
  const cli = path.join(root, "codex")
  await writeFile(cli, "fixture", { mode: 0o700 }); await chmod(cli, 0o700)
  return { root, cli, environment: { HOME: root, PATH: root, CODEX_EXECUTABLE: cli, CODEX_HOME: path.join(root, "account"), HTTPS_PROXY: "http://private-proxy:7890" } }
}

test("readiness checks only the selected CLI and its login status without inference", async () => {
  const f = await fixture(), calls: string[][] = []
  let signedIn = false
  try {
    const setup = createProviderSetup({ dataDir: f.root, getEnvironment: async () => f.environment, run: async (cli, args, env) => {
      expect(cli).toBe(f.cli); expect(env.CODEX_HOME).toBe(f.environment.CODEX_HOME)
      calls.push(args); return { code: args[0] === "--version" || signedIn ? 0 : 1, stdout: args[0] === "--version" ? "codex-fixture" : "" }
    } })
    expect((await setup.status("codex", true)).state).toBe("signed-out")
    signedIn = true
    expect((await setup.status("codex", false)).state).toBe("ready")
    expect(calls).toEqual([["--version"], ["login", "status"], ["--version"], ["login", "status"]])
    expect((await setup.status("claude", false)).installed).toBe(false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("macOS terminal uses the resolved CLI and account/proxy environment without secrets in launch arguments", async () => {
  const f = await fixture(), launches: { command: string; args: string[] }[] = []
  try {
    const setup = createProviderSetup({ dataDir: f.root, platform: "darwin", getEnvironment: async () => f.environment, launch: async (command, args) => { launches.push({ command, args }) } })
    await setup.openTerminal("codex", "login")
    expect(launches[0]!.command).toBe("/usr/bin/open")
    expect(launches[0]!.args.slice(0, 2)).toEqual(["-a", "Terminal"])
    const file = launches[0]!.args[2]!, script = await readFile(file, "utf8")
    expect(script).toContain("export CODEX_HOME=")
    expect(script).toContain("export HTTPS_PROXY=")
    expect(script).toContain("'login'")
    expect(script).toContain('rm -- "$0"')
    expect(script).toContain("'\\''")
    expect(launches[0]!.args.join(" ")).not.toContain("private-proxy")
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o700)
    await expect(setup.openTerminal("codex", "install")).rejects.toThrow("existing CLI")
    expect(launches.length).toBe(1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("Windows opens a visible PowerShell with a Unicode script, never a desktop Agent app", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon powershell ")), launches: string[][] = []
  try {
    const setup = createProviderSetup({ dataDir: root, platform: "win32", getEnvironment: async () => ({ HOME: root, PATH: "", HTTPS_PROXY: "http://private-proxy:7890" }), launch: async (command, args) => { expect(command).toContain("powershell.exe"); launches.push(args) } })
    await setup.openTerminal("codex", "install")
    const decoded = Buffer.from(launches[0]!.at(-1)!, "base64").toString("utf16le")
    expect(decoded).toContain("-WindowStyle Normal")
    expect(decoded).toContain("-NoExit")
    expect(decoded).not.toContain("private-proxy")
    const file = path.join(root, "setup", (await readdir(path.join(root, "setup")))[0]!)
    const script = await readFile(file, "utf8")
    expect(script.charCodeAt(0)).toBe(0xfeff)
    expect(script).toContain("https://chatgpt.com/codex/install.ps1")
    expect(script).toContain("Remove-Item -LiteralPath $PSCommandPath")
    expect(script).not.toContain("codex app")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("CLI overrides are saved once for checks/conversations and support manual edits and removal", async () => {
  const f = await fixture()
  try {
    const settings = new ProviderCliSettings(f.root)
    await Promise.all([settings.set("codex", f.cli), settings.set("claude", f.cli)])
    expect(settings.environment({}).CODEX_EXECUTABLE).toBe(f.cli)
    expect(settings.environment({}).CLAUDE_EXECUTABLE).toBe(f.cli)
    const saved = JSON.parse(await readFile(settings.filePath, "utf8"))
    expect(saved.schemaVersion).toBe(1)
    await writeFile(settings.filePath, JSON.stringify({ schemaVersion: 1, claude: f.cli }))
    expect(settings.environment({}).CODEX_EXECUTABLE).toBeUndefined()
    await settings.set("claude", null)
    expect(settings.environment({}).CLAUDE_EXECUTABLE).toBeUndefined()
    await expect(settings.set("codex", path.join(f.root, "missing"))).rejects.toThrow("missing")
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("setup HTTP rejects remote terminal/config actions, wrong methods and cross-origin writes", async () => {
  let launches = 0
  const setup = { status: async (provider: "codex" | "claude", local: boolean) => ({ provider, state: "missing" as const, installed: false, platform: "darwin", canOpenTerminal: local }), openTerminal: async () => { launches++; return { opened: true } } }
  const url = new URL("http://localhost/api/provider-setup/codex/login")
  const options = { local: false, validateOrigin: () => true, settings: { set: async () => {} }, setup }
  expect((await handleProviderSetupRequest(new Request(url, { method: "POST" }), url, options))!.status).toBe(403)
  expect(launches).toBe(0)
  expect((await handleProviderSetupRequest(new Request(url, { method: "POST" }), url, { ...options, local: true, validateOrigin: () => false }))!.status).toBe(403)
  expect((await handleProviderSetupRequest(new Request(url), url, { ...options, local: true }))!.status).toBe(405)
  expect((await handleProviderSetupRequest(new Request(url, { method: "POST" }), url, { ...options, local: true }))!.status).toBe(200)
  expect(launches).toBe(1)
})

test("terminal scripts keep login commands provider-specific", () => {
  const script = providerTerminalScript({ platform: "win32", environment: { HOME: "C:\\Users\\example" }, executable: "C:\\Tools\\claude.exe", provider: "claude", action: "login" })
  expect(script).toContain("& 'C:\\Tools\\claude.exe' 'auth' 'login'")
  expect(script).not.toContain("install.ps1")
})

test.skipIf(process.platform === "win32")("the POSIX login script runs the chosen CLI with the same account context and removes itself", async () => {
  const f = await fixture()
  try {
    await mkdir(f.environment.CODEX_HOME)
    await writeFile(f.cli, '#!/bin/sh\nprintf "%s\\n" "$1" "$CODEX_HOME" "$HTTPS_PROXY" > "$CODEX_HOME/called.txt"\n')
    const file = path.join(f.root, "login.command")
    await writeFile(file, providerTerminalScript({ platform: "darwin", environment: f.environment, executable: f.cli, provider: "codex", action: "login" }))
    const child = Bun.spawn(["/bin/sh", file], { stdin: Buffer.from("\n"), stdout: "ignore", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect((await readFile(path.join(f.environment.CODEX_HOME, "called.txt"), "utf8")).trim().split("\n")).toEqual(["login", f.environment.CODEX_HOME, "http://private-proxy:7890"])
    await expect(stat(file)).rejects.toHaveProperty("code", "ENOENT")
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "win32")("native PowerShell executes a CLI path with spaces and Unicode and removes its helper", async () => {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const root = await mkdtemp(path.join(tmpdir(), "stillon 工作 "))
  try {
    const cli = path.join(root, "fixture.cmd"), file = path.join(root, "login.ps1")
    await writeFile(cli, '@echo %1 > "%CODEX_HOME%\\called.txt"\r\n')
    const environment = { HOME: root, CODEX_HOME: root }
    await writeFile(file, "\uFEFF" + providerTerminalScript({ platform: "win32", environment, executable: cli, provider: "codex", action: "login" }))
    const shell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    await promisify(execFile)(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { timeout: 10_000, windowsHide: true })
    expect((await readFile(path.join(root, "called.txt"), "utf8")).trim()).toBe("login")
    await expect(stat(file)).rejects.toHaveProperty("code", "ENOENT")
  } finally { await rm(root, { recursive: true, force: true }) }
})
