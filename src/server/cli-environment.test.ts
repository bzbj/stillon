import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { cliFallbackPath, environmentPath, findCliExecutable, mergeSearchPaths, refreshCliEnvironment } from "./cli-environment"
import { getCodexCliCommand } from "./codex-cli-command"

test("fresh Windows user PATH replaces a stale snapshot while keeping inherited fallbacks", async () => {
  const environment = await refreshCliEnvironment({ platform: "win32", environment: { Path: "C:\\old;C:\\Windows", HOME: "C:\\Users\\example", CODEX_HOME: "C:\\accounts\\codex" }, readPath: async (command, args) => {
    expect(command).toContain("WindowsPowerShell")
    expect(args.join(" ")).toContain("GetEnvironmentVariable('Path','User')")
    return "C:\\Windows;C:\\new\r\n"
  } })
  expect(environment.PATH!.split(";").slice(0, 3)).toEqual(["C:\\Windows", "C:\\new", "C:\\old"])
  expect(environment.Path).toBeUndefined()
  expect(environment.CODEX_HOME).toBe("C:\\accounts\\codex")
})

test("macOS reads the login shell PATH despite startup banners and preserves account/network settings", async () => {
  const environment = await refreshCliEnvironment({ platform: "darwin", environment: { HOME: "/Users/example", SHELL: "/bin/zsh", PATH: "/old/bin:/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890", CODEX_HOME: "/accounts/codex" }, readPath: async (command, args) => {
    expect(command).toBe("/bin/zsh"); expect(args[0]).toBe("-ilc")
    return "shell banner\n__STILLON_PATH__/new/nvm/bin:/usr/bin\n"
  } })
  expect(environment.PATH!.startsWith("/new/nvm/bin:/usr/bin:/old/bin")).toBe(true)
  expect(environment.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
  expect(environment.CODEX_HOME).toBe("/accounts/codex")
})

test("explicit agent PATH wins and failed discovery keeps existing directories", async () => {
  const environment = { HOME: "/Users/example", PATH: "/custom/bin", STILLON_AGENT_PATH: "/chosen/bin" }
  const result = await refreshCliEnvironment({ platform: "darwin", environment, readPath: async () => { throw new Error("must not run") } })
  expect(result.PATH!.startsWith("/chosen/bin:/custom/bin")).toBe(true)
  const fallback = await refreshCliEnvironment({ platform: "darwin", environment: { HOME: environment.HOME, PATH: environment.PATH }, readPath: async () => { throw new Error("shell timed out") } })
  expect(fallback.PATH!.startsWith("/custom/bin:")).toBe(true)
  expect(cliFallbackPath(environment.HOME, "darwin")).toContain("/opt/homebrew/bin")
})

test("Windows PATH comparison deduplicates without changing directory precedence", () => {
  expect(environmentPath({ Path: "stale", PATH: "explicit" })).toBe("explicit")
  expect(mergeSearchPaths("win32", "C:\\Custom;C:\\WINDOWS", "c:\\custom\\;C:\\New")).toBe("C:\\Custom;C:\\WINDOWS;C:\\New")
})

test("Codex detection and launch use the same executable in a path with spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon cli "))
  try {
    const binary = path.join(root, process.platform === "win32" ? "codex.exe" : "codex")
    if (process.platform === "win32") await copyFile(process.execPath, binary)
    else { await writeFile(binary, "#!/bin/sh\nprintf 'codex-fixture\\n'\n"); await chmod(binary, 0o755) }
    const environment = { ...process.env, PATH: root }
    expect(getCodexCliCommand(process.platform, environment)).toBe(binary)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(getCodexCliCommand(process.platform, environment), ["--version"], { env: environment })
      let stdout = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.resume()
      child.on("error", reject); child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`)))
    })
    expect(output.trim()).toBe(process.platform === "win32" ? Bun.version : "codex-fixture")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "win32")("Windows supports npm .cmd shims and honors an earlier PATH entry over another .exe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon cli "))
  try {
    const first = path.join(root, "npm"), second = path.join(root, "native")
    await mkdir(first); await mkdir(second)
    const shim = path.join(first, "codex.cmd")
    await writeFile(shim, `@"${process.execPath}" %*\r\n`)
    await copyFile(process.execPath, path.join(second, "codex.exe"))
    const environment = { ...process.env, PATH: `${first};${second}` }
    expect(findCliExecutable("codex", environment)).toBe(shim)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(getCodexCliCommand(process.platform, environment), ["--version"], { env: environment })
      let stdout = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.resume()
      child.on("error", reject); child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`)))
    })
    expect(output.trim()).toBe(Bun.version)
  } finally { await rm(root, { recursive: true, force: true }) }
})
