import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createCliUpdateFixture } from "../../scripts/provider-cli-update-fixture"
import { inspectCliInstallation, type CliInstallation } from "./provider-cli-installation"
import { runCliInstaller } from "./provider-cli-installer"
import { CliUpdateJournals, cliInstallerAlive, type CliUpdateJournal } from "./provider-cli-journal"
import { ProviderCliUpdates, type ProviderCliUpdatesOptions } from "./provider-cli-updates"

const release = { version: "1.2.4", publishedAt: "2026-01-01T00:00:00.000Z", url: "https://github.com/openai/codex/releases/tag/rust-v1.2.4" }
const original: CliInstallation = { executable: "/example/bin/codex", version: "1.2.3", identity: "original", label: "npm", automaticUpdates: "Off", method: { kind: "npm", prefix: "/example" } }
async function eventually(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { if (await read()) return; await Bun.sleep(50) }
  throw new Error("Timed out waiting for the synthetic CLI installer")
}

test("a damaged npm install is retried once, verified and persisted without installer output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-recovery-"))
  let current = { ...original }, attempts = 0
  const options: ProviderCliUpdatesOptions = { journalDirectory: root, getEnvironment: async () => ({}),
    inspect: async () => current, reserve: async () => () => {}, release: async () => release, verify: async () => {},
    install: async () => {
      attempts++
      current = { ...original, version: attempts === 1 ? undefined : "1.2.4", identity: `attempt-${attempts}` }
      if (attempts === 1) throw new Error("TOKEN=private-output")
    } }
  try {
    const manager = new ProviderCliUpdates(options)
    await manager.start("codex", (await manager.status("codex")).updateToken!)
    await manager.close()
    expect(attempts).toBe(2)
    expect((await manager.status("codex")).operation?.state).toBe("succeeded")
    const saved = await readFile(path.join(root, "codex.json"), "utf8")
    expect(saved).not.toContain("private-output")
    expect(JSON.parse(saved).attempts).toBe(2)
    const restarted = new ProviderCliUpdates(options)
    expect((await restarted.status("codex")).operation?.state).toBe("succeeded")
    await restarted.recoverInterrupted(); await restarted.close()
    expect(attempts).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("bounded repair survives failure and requires new opaque consent at the same installation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-repair-"))
  let current = { ...original }, attempts = 0, succeeds = false
  const options: ProviderCliUpdatesOptions = { journalDirectory: root, getEnvironment: async () => ({}),
    inspect: async () => current, reserve: async () => () => {}, release: async () => release, verify: async () => {},
    install: async () => { attempts++; current = { ...original, version: succeeds ? "1.2.4" : undefined, identity: `attempt-${attempts}` }; if (!succeeds) throw new Error("private error") } }
  try {
    const manager = new ProviderCliUpdates(options)
    const token = (await manager.status("codex")).updateToken!
    await manager.start("codex", token); await manager.close()
    expect(attempts).toBe(2)
    const restarted = new ProviderCliUpdates({ ...options, release: async () => { throw new Error("offline") } })
    const broken = await restarted.status("codex")
    expect(broken.operation?.state).toBe("failed"); expect(broken.repairVersion).toBe("1.2.4")
    expect(broken.repairToken).toBeDefined(); expect(attempts).toBe(2)
    succeeds = true
    await restarted.start("codex", broken.repairToken!); await restarted.close()
    expect(attempts).toBe(3)
    expect((await restarted.status("codex")).operation?.state).toBe("succeeded")
    await expect(restarted.start("codex", token)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("selection changes and working older versions never trigger automatic repair", async () => {
  for (const selected of [{ ...original }, { ...original, executable: "/other/codex", version: undefined }, { ...original, version: "1.2.5" }]) {
    let current = original, attempts = 0
    const manager = new ProviderCliUpdates({ getEnvironment: async () => ({}), inspect: async () => current,
      reserve: async () => () => {}, release: async () => release, verify: async () => {},
      install: async () => { attempts++; current = selected; throw new Error("private output") } })
    await manager.start("codex", (await manager.status("codex")).updateToken!); await manager.close()
    expect(attempts).toBe(1)
    expect((await manager.status("codex")).operation?.state).toBe("failed")
  }
})

test("missing npm shims and broken package binaries are repairable, but arbitrary configured paths are not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-missing-"))
  try {
    const engine = await createCliUpdateFixture(root)
    const broken = await inspectCliInstallation("codex", engine.environment, process.platform, async () => { throw new Error("Missing optional dependency") })
    expect(broken.damaged).toBe(true); expect(broken.method).toEqual({ kind: "npm", prefix: await realpath(root) })
    await rm(engine.executable)
    const missing = await inspectCliInstallation("codex", engine.environment)
    expect(missing.damaged).toBe(true); expect(missing.method).toEqual({ kind: "npm", prefix: await realpath(root) })
    expect(missing.version).toBeUndefined()
    expect((await inspectCliInstallation("codex", { ...engine.environment, NPM_CONFIG_PREFIX: "", npm_config_prefix: "", APPDATA: "" })).method).toBeUndefined()
    const unrelated = await inspectCliInstallation("codex", { ...engine.environment, CODEX_EXECUTABLE: path.join(root, "other-codex") })
    expect(unrelated.method).toBeUndefined()
    const manager = new ProviderCliUpdates({ ...engine.options, getEnvironment: async () => engine.environment, reserve: async () => () => {} })
    const before = await manager.status("codex")
    expect(before.updateToken).toBeUndefined(); expect(before.repairToken).toBeDefined()
    await manager.start("codex", before.repairToken!); await manager.close()
    // The synthetic installer does not relink shims: exercise the bounded error.
    expect((await manager.status("codex")).operation?.state).toBe("failed")
    expect((await readFile(engine.calls, "utf8")).trim().split("\n")).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("installer output beyond execFile's limit cannot kill a writing package manager", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-output-"))
  try {
    const marker = path.join(root, "completed")
    await runCliInstaller(process.execPath, ["-e", `process.stdout.write('x'.repeat(2*1024*1024));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'complete'),100)`], { ...process.env, HOME: root, USERPROFILE: root })
    expect(await readFile(marker, "utf8")).toBe("complete")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("npm prefix identity is stable through directory aliases before and after shim retirement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-alias-"))
  try {
    const prefix = path.join(root, "prefix"), alias = path.join(root, "alias")
    await mkdir(prefix)
    await symlink(prefix, alias, process.platform === "win32" ? "junction" : "dir")
    const engine = await createCliUpdateFixture(alias)
    const before = await inspectCliInstallation("codex", engine.environment)
    expect(before.method).toEqual({ kind: "npm", prefix: await realpath(prefix) })
    await rm(engine.executable)
    const after = await inspectCliInstallation("codex", engine.environment)
    expect(after.executable).toBe(before.executable)
    expect(after.method).toEqual(before.method)
    expect(after.damaged).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("corrupt journals fail closed for updates while status remains readable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-invalid-"))
  try {
    await writeFile(path.join(root, "codex.json"), '{"schema":999}')
    let attempts = 0
    const manager = new ProviderCliUpdates({ journalDirectory: root, getEnvironment: async () => ({}), inspect: async () => original,
      reserve: async () => () => {}, release: async () => release, install: async () => { attempts++ } })
    const status = await manager.status("codex")
    expect(status.updateToken).toBeUndefined(); expect(status.reason).toContain("recovery record")
    await manager.recoverInterrupted(); await manager.close(); expect(attempts).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("failure to persist consent prevents the installer from starting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-readonly-"))
  const journalDirectory = path.join(root, "journal")
  let attempts = 0
  const manager = new ProviderCliUpdates({ journalDirectory, getEnvironment: async () => ({}), inspect: async () => original,
    reserve: async () => () => {}, release: async () => release, install: async () => { attempts++ } })
  try {
    const token = (await manager.status("codex")).updateToken!
    await writeFile(journalDirectory, "Cannot create a journal directory here")
    await expect(manager.start("codex", token)).rejects.toThrow("installer was not started")
    expect(attempts).toBe(0); expect(manager.busy).toBe(false)
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})

test("a surviving installer holds the maintenance lock until it exits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-survivor-"))
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  let current: CliInstallation = { ...original, version: undefined }, attempts = 0, reserved = false
  const record: CliUpdateJournal = { schema: 1, provider: "codex", installation: original, phase: "installing", attempts: 1, installerPid: child.pid,
    updatedAt: new Date().toISOString(), operation: { id: "surviving", targetVersion: "1.2.4", startedAt: new Date().toISOString(), state: "updating", message: "Installing" } }
  await new CliUpdateJournals(root).write(record)
  const manager = new ProviderCliUpdates({ journalDirectory: root, getEnvironment: async () => ({}), inspect: async () => current,
    reserve: async () => { reserved = true; return () => { reserved = false } }, release: async () => release, verify: async () => {},
    install: async () => { attempts++; current = { ...original, version: "1.2.4" } } })
  try {
    const recovery = manager.recoverInterrupted()
    await eventually(async () => reserved)
    await Bun.sleep(100)
    expect(manager.busy).toBe(true); expect(attempts).toBe(0)
    expect((await manager.status("codex")).repairToken).toBeUndefined()
    child.kill(); await child.exited
    await recovery
    expect(attempts).toBe(1); expect(reserved).toBe(false)
    expect((await manager.status("codex")).operation?.state).toBe("succeeded")
  } finally { child.kill(); await child.exited; await manager.close(); await rm(root, { recursive: true, force: true }) }
})

test("a real interrupted npm write resumes after restart, waits for the surviving installer and restores its shim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-interrupted-"))
  let worker: ReturnType<typeof Bun.spawn> | undefined, installerPid: number | undefined
  let manager: ProviderCliUpdates | undefined
  try {
    const engine = await createCliUpdateFixture(path.join(root, "npm"))
    const journalDirectory = path.join(root, "journal"), interrupted = path.join(root, "interrupted"), retired = path.join(root, "retired")
    const pkg = path.join(path.dirname(engine.npmScript), "../../@openai/codex")
    const manifest = path.join(pkg, "package.json")
    const npmCode = await readFile(engine.npmScript, "utf8"), manifestCode = await readFile(manifest, "utf8")
    const launcherCode = process.platform === "win32" ? await readFile(engine.executable, "utf8") : ""
    await writeFile(interrupted, "interrupt")
    await writeFile(engine.npmScript, `
const fs=require('node:fs');
if(fs.existsSync(${JSON.stringify(interrupted)})){
 fs.unlinkSync(${JSON.stringify(interrupted)});fs.appendFileSync(${JSON.stringify(engine.calls)},'install\\n');
 fs.unlinkSync(${JSON.stringify(engine.executable)});fs.unlinkSync(${JSON.stringify(manifest)});
 fs.writeFileSync(${JSON.stringify(retired)},'ready');setInterval(()=>{},1000);
}else{
 fs.writeFileSync(${JSON.stringify(manifest)},${JSON.stringify(manifestCode)});
 ${process.platform === "win32" ? `fs.writeFileSync(${JSON.stringify(engine.executable)},${JSON.stringify(launcherCode)});` : `fs.symlinkSync(${JSON.stringify(path.join(pkg, "cli.js"))},${JSON.stringify(engine.executable)});`}
 { ${npmCode} }
}`)
    const workerFile = path.join(root, "worker.ts")
    const environment = Object.fromEntries(["HOME", "USERPROFILE", "PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "CODEX_HOME", "CODEX_EXECUTABLE", "CLAUDE_EXECUTABLE"]
      .flatMap(key => engine.environment[key as keyof typeof engine.environment] ? [[key, engine.environment[key as keyof typeof engine.environment]]] : []))
    await writeFile(workerFile, `import {ProviderCliUpdates} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "provider-cli-updates.ts")).href)};
const manager=new ProviderCliUpdates({journalDirectory:${JSON.stringify(journalDirectory)},getEnvironment:async()=>(${JSON.stringify(environment)}),reserve:async()=>()=>{},release:async()=>(${JSON.stringify(release)})});
await manager.start('codex',(await manager.status('codex')).updateToken);await manager.close();`)
    worker = Bun.spawn([process.execPath, "--no-env-file", workerFile], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(path.join(root, "worker-errors")) })
    const journal = new CliUpdateJournals(journalDirectory)
    await eventually(async () => {
      if (worker!.exitCode !== null) throw new Error(`Synthetic update worker exited: ${await readFile(path.join(root, "worker-errors"), "utf8")}; journal: ${JSON.stringify(await journal.read("codex"))}`)
      const record = await journal.read("codex")
      installerPid = record?.installerPid
      return !!installerPid && await Bun.file(retired).exists()
    })
    worker.kill(); await worker.exited
    const survived = cliInstallerAlive(installerPid!)
    expect((await inspectCliInstallation("codex", engine.environment)).version).toBeUndefined()
    manager = new ProviderCliUpdates({ ...engine.options, journalDirectory, getEnvironment: async () => engine.environment, reserve: async () => () => {} })
    const recovery = manager.recoverInterrupted()
    await eventually(async () => manager!.busy)
    if (survived) {
      await Bun.sleep(150)
      expect(await readFile(engine.calls, "utf8")).toBe("install\n")
      process.kill(installerPid!)
    }
    installerPid = undefined
    await recovery
    const status = await manager.status("codex")
    expect(status.operation?.state).toBe("succeeded")
    expect(status.currentVersion).toBe("1.2.4")
    expect(status.executable).toBe(engine.executable)
    expect(await readFile(engine.calls, "utf8")).toBe("install\ninstall\n")
    expect((await journal.read("codex"))?.attempts).toBe(2)
  } finally {
    worker?.kill(); await worker?.exited
    if (installerPid && cliInstallerAlive(installerPid)) process.kill(installerPid)
    await manager?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 20_000)

test("an interrupted record without a known installer PID never starts a second installer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-cli-unknown-"))
  try {
    const record: CliUpdateJournal = { schema: 1, provider: "codex", installation: original, phase: "installing", attempts: 1, updatedAt: new Date().toISOString(),
      operation: { id: "synthetic", targetVersion: "1.2.4", startedAt: new Date().toISOString(), state: "updating", message: "Installing" } }
    await new CliUpdateJournals(root).write(record)
    let attempts = 0
    const manager = new ProviderCliUpdates({ journalDirectory: root, getEnvironment: async () => ({}),
      inspect: async () => ({ ...original, version: undefined, damaged: true }), reserve: async () => () => {}, release: async () => release,
      install: async () => { attempts++ } })
    await manager.recoverInterrupted()
    const status = await manager.status("codex")
    expect(status.repairToken).toBeUndefined(); expect(attempts).toBe(0)
    expect(status.reason).toContain("could still be running")
    await manager.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})
