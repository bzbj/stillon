import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { inspectCliInstallation, newerCliVersion, npmUpdateCommand, runCli, type CliInstallation } from "./provider-cli-installation"
import { installCli, ProviderCliUpdates, verifyCli, type ProviderCliUpdatesOptions } from "./provider-cli-updates"
import { createCliUpdateFixture } from "../../scripts/provider-cli-update-fixture"
import { handleProviderCliUpdates } from "./provider-cli-updates-http"
import { AgentCoordinator } from "./agent"

const release = { version: "1.2.4", publishedAt: "2026-01-01T00:00:00.000Z", url: "https://github.com/openai/codex/releases/tag/rust-v1.2.4" }
function fixture(overrides: Partial<ProviderCliUpdatesOptions> = {}) {
  let installation: CliInstallation = { executable: "/example/bin/codex", version: "1.2.3", identity: "before", label: "npm", automaticUpdates: "Off", method: { kind: "npm", prefix: "/example" } }
  const calls: string[] = []
  const manager = new ProviderCliUpdates({ getEnvironment: async () => ({}), inspect: async () => installation,
    release: async () => release, reserve: async () => { calls.push("reserve"); return () => { calls.push("release") } },
    install: async (_, current, target) => { calls.push("install"); expect(current.executable).toBe(installation.executable); installation = { ...installation, version: target, identity: "after" } },
    verify: async () => { calls.push("verify") }, ...overrides })
  return { manager, calls, set: (value: Partial<CliInstallation>) => { installation = { ...installation, ...value } } }
}
test("semantic versions never downgrade, lexically misorder or silently replace previews", () => {
  expect(newerCliVersion("1.10.0", "1.9.9")).toBe(true)
  for (const [latest, current] of [["1.0.0", "2.0.0"], ["1.2.3", "1.2.3"], ["1.2.4", "1.2.4-beta.1"], ["1.2.4;echo", "1.2.3"]]) expect(newerCliVersion(latest!, current!)).toBe(false)
})
test("checking releases is read-only; consent updates just once then verifies", async () => {
  const f = fixture()
  const first = await f.manager.status("codex"), second = await f.manager.status("codex")
  expect(f.calls).toEqual([]); expect(first.updateToken).toBe(second.updateToken)
  expect((await f.manager.start("codex", first.updateToken!)).targetVersion).toBe(release.version)
  await f.manager.close()
  expect(f.calls).toEqual(["reserve", "install", "verify", "release"])
  const done = await f.manager.status("codex")
  expect(done.operation?.state).toBe("succeeded"); expect(done.currentVersion).toBe(release.version); expect(done.updateToken).toBeUndefined()
  await expect(f.manager.start("codex", first.updateToken!)).rejects.toThrow()
})
test("changed selection invalidates consent without invoking an installer", async () => {
  const f = fixture(), status = await f.manager.status("codex")
  f.set({ identity: "different", executable: "/example/other/codex" })
  await expect(f.manager.start("codex", status.updateToken!)).rejects.toThrow("changed")
  expect(f.calls).toEqual(["reserve", "release"]); expect(f.manager.busy).toBe(false)
})
test("active work prevents updating; simultaneous providers cannot race", async () => {
  const blocked = fixture({ reserve: async () => { throw new Error("Active agent work") } })
  await expect(blocked.manager.start("codex", (await blocked.manager.status("codex")).updateToken!)).rejects.toThrow("Active agent")
  expect(blocked.calls).toEqual([])
  let finish!: () => void
  const f = fixture({ install: () => new Promise(resolve => { finish = resolve }) })
  const [a, b] = await Promise.all([f.manager.status("codex"), f.manager.status("claude")])
  await f.manager.start("codex", a.updateToken!)
  await expect(f.manager.start("claude", b.updateToken!)).rejects.toThrow("in progress")
  expect(f.manager.busy).toBe(true); finish(); await f.manager.close(); expect(f.manager.busy).toBe(false)
})
test("partial installs, path changes and model verification failures never report success or leak output", async () => {
  for (const kind of ["install", "version", "path", "models"] as const) {
    const f = fixture({ install: async () => {
      if (kind === "install") throw new Error("TOKEN=secret; /private/home")
      f.set({ version: kind === "version" ? "1.2.3" : release.version, executable: kind === "path" ? "/other/cli" : "/example/bin/codex" })
    }, verify: async () => { if (kind === "models") throw new Error("TOKEN=secret; /private/home") } })
    await f.manager.start("codex", (await f.manager.status("codex")).updateToken!)
    await f.manager.close()
    const done = await f.manager.status("codex")
    expect(done.operation?.state).toBe("failed"); expect(JSON.stringify(done)).not.toContain("secret"); expect(f.calls.at(-1)).toBe("release")
  }
})
test("catalog errors, missing and unrecognized installations never offer an unsafe update", async () => {
  const offline = fixture({ release: async () => { throw new Error("secret upstream output") } })
  const status = await offline.manager.status("codex")
  expect(status.releaseError).toBeDefined(); expect(status.latest).toBeUndefined(); expect(status.updateToken).toBeUndefined()
  for (const installation of [{ method: undefined }, { method: undefined, version: undefined, executable: undefined }]) {
    const f = fixture(); f.set(installation)
    expect((await f.manager.status("codex")).updateToken).toBeUndefined()
    expect(f.calls).toEqual([])
  }
})
test("HTTP requires origin and bounded opaque consent, consumes rejected bodies, and uses no-store", async () => {
  const f = fixture(), url = new URL("http://localhost/api/provider-cli-updates/codex")
  const post = (body: object) => new Request(url, { method: "POST", body: JSON.stringify(body) })
  const rejected = post({ updateToken: "bad" })
  expect((await handleProviderCliUpdates(rejected, url, f.manager, () => false))?.status).toBe(403)
  expect(rejected.bodyUsed).toBe(true)
  const response = (await handleProviderCliUpdates(new Request(url), url, f.manager, () => true))!
  expect(response.headers.get("cache-control")).toBe("no-store")
  const status = await response.json()
  for (const body of [{ updateToken: status.updateToken, executable: "attacker" }, { updateToken: "x".repeat(600) }, { command: "install" }]) expect((await handleProviderCliUpdates(post(body), url, f.manager, () => true))?.status).toBe(400)
  expect((await handleProviderCliUpdates(post({ updateToken: status.updateToken }), url, f.manager, () => true))?.status).toBe(202)
  await f.manager.close()
})
test("agent maintenance waits for old sessions and prevents new launches until released", async () => {
  let finish!: () => void, stopped = false
  const agent = new AgentCoordinator({ store: {} as never, onStateChange: () => {}, codexManager: { stopAll: () => new Promise<void>(resolve => { finish = () => { stopped = true; resolve() } }) } as never })
  const reservation = agent.reserveCliUpdate()
  await expect(agent.reserveCliUpdate()).rejects.toThrow("active agent work")
  expect(stopped).toBe(false)
  const args = { chatId: "example", provider: "codex" }
  await expect((agent as any).startTurnForChat(args)).rejects.toThrow("CLI update")
  finish(); const releaseLock = await reservation; expect(stopped).toBe(true); releaseLock()
})

test("npm ownership requires the selected bin/shim, and updates preserve a prefix containing spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon CLI ' & "))
  const windows = process.platform === "win32", bin = windows ? root : path.join(root, "bin")
  const pkg = path.join(root, windows ? "node_modules" : "lib/node_modules", "@openai/codex")
  const cli = path.join(bin, windows ? "codex.cmd" : "codex")
  try {
    await mkdir(pkg, { recursive: true }); await mkdir(bin, { recursive: true })
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "cli.js" } }))
    await writeFile(path.join(pkg, "cli.js"), "fixture")
    // Windows shims have to name the package. A copied arbitrary codex file
    // beside a global package must not authorize updating that package.
    await writeFile(cli, windows ? "node %dp0%/node_modules/@openai/codex/cli.js" : "fixture", { mode: 0o700 }); await chmod(cli, 0o700)
    const env = { HOME: root, USERPROFILE: root, PATH: bin, CODEX_EXECUTABLE: cli }
    const found = await inspectCliInstallation("codex", env, process.platform, async () => "codex-cli 1.2.3")
    expect(found.executable).toBe(cli)
    if (windows) expect(found.method).toEqual({ kind: "npm", prefix: root })
    else expect(found.method).toBeUndefined()
    await writeFile(cli, "unrelated executable", { mode: 0o700 })
    expect((await inspectCliInstallation("codex", env, process.platform, async () => "1.2.3")).method).toBeUndefined()
    await expect(npmUpdateCommand(env, root, "codex", "1.2.4; echo bad")).rejects.toThrow("Invalid release")
  } finally { await rm(root, { recursive: true, force: true }) }
})
test.skipIf(process.platform !== "win32")("Windows batch arguments remain literal even with shell metacharacters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon CLI ' & "))
  try {
    const cli = path.join(root, "echo.cmd")
    await writeFile(cli, "@echo off\r\necho fixture-ok\r\n")
    const output = await runCli(cli, ["--version"], { ...process.env, HOME: root, USERPROFILE: root })
    expect(output.trim()).toBe("fixture-ok")
    expect(await readFile(cli, "utf8")).toContain("fixture-ok")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("native installers stay in the selected location and report their own auto-update policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-native-cli-"))
  try {
    const windows = process.platform === "win32", bin = path.join(root, ".local/bin")
    const claude = path.join(bin, windows ? "claude.exe" : "claude")
    await mkdir(bin, { recursive: true }); await mkdir(path.join(root, ".local/share/claude/versions"), { recursive: true })
    await writeFile(claude, "fixture", { mode: 0o700 }); await chmod(claude, 0o700)
    const env = { HOME: root, USERPROFILE: root, PATH: bin, CLAUDE_EXECUTABLE: claude, DISABLE_AUTOUPDATER: "1" }
    const result = await inspectCliInstallation("claude", env, process.platform, async () => "2.1.0 (Claude Code)")
    expect(result.method).toEqual({ kind: "native", binDir: bin })
    expect(result.automaticUpdates).toContain("disabled")
    const codexBin = windows ? path.join(root, "AppData/Local/Programs/OpenAI/Codex/bin") : bin
    const codex = path.join(codexBin, windows ? "codex.exe" : "codex")
    await mkdir(codexBin, { recursive: true }); await mkdir(path.join(root, ".codex/packages/standalone"), { recursive: true })
    await writeFile(codex, "fixture", { mode: 0o700 }); await chmod(codex, 0o700)
    const found = await inspectCliInstallation("codex", { HOME: root, USERPROFILE: root, PATH: codexBin, CODEX_EXECUTABLE: codex }, process.platform, async () => "codex-cli 1.2.3")
    expect(found.method).toEqual({ kind: "native", binDir: codexBin })
    expect(found.automaticUpdates).toContain("could not be determined")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("inaccessible App components never authorize a separate CLI install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-app-cli-"))
  try {
    const bin = path.join(root, "Example.app", "Contents/Resources"), cli = path.join(bin, "codex")
    await mkdir(bin, { recursive: true }); await writeFile(cli, "fixture", { mode: 0o700 }); await chmod(cli, 0o700)
    const found = await inspectCliInstallation("codex", { HOME: root, USERPROFILE: root, PATH: bin, CODEX_EXECUTABLE: cli }, process.platform, async () => { throw new Error("EPERM") })
    expect(found.label).toBe("App-managed component"); expect(found.method).toBeUndefined(); expect(found.reason).toContain("desktop app")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a real fresh App Server with mismatched version is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-mismatch-cli-"))
  try {
    const engine = await createCliUpdateFixture(root)
    const installation = await inspectCliInstallation("codex", engine.environment)
    await writeFile(engine.serverVersion, "0.9.0")
    await expect(verifyCli("codex", installation, engine.environment)).rejects.toThrow("different version")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("Claude npm and native updates request the exact target using the existing executable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-claude-cli-"))
  try {
    const engine = await createCliUpdateFixture(root, "claude")
    const manager = new ProviderCliUpdates({ ...engine.options, getEnvironment: async () => engine.environment, reserve: async () => () => {} })
    const before = await manager.status("claude")
    expect(before.installation).toBe("npm"); expect(before.currentVersion).toBe("1.2.3")
    expect(before.automaticUpdates).toContain("background updates with npm")
    await manager.start("claude", before.updateToken!); await manager.close()
    expect((await manager.status("claude")).operation?.state).toBe("succeeded")
    expect(await engine.installed()).toBe("1.2.4")
    const current = await inspectCliInstallation("claude", engine.environment)
    await installCli("claude", { ...current, method: { kind: "native", binDir: path.dirname(engine.executable) } }, "1.2.5", engine.environment)
    expect(await engine.installed()).toBe("1.2.5")
    expect((await inspectCliInstallation("claude", engine.environment)).executable).toBe(before.executable)
  } finally { await rm(root, { recursive: true, force: true }) }
})
