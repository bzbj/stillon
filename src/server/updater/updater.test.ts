import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createManagedAppControl } from "./app-control"
import { atomicJson, copyTree, inside, json, manifest } from "./files"
import { claimRequest, enqueueUpdate, UpdateEngine, type UpdateEffects } from "./engine"
import { parseUpdateArgs } from "./cli"
import { macosUpdaterPlist, windowsUpdaterXml } from "./native"
import { newerRelease, releaseTag, updateRoot, updateTarget, type UpdateDeployment, type UpdateState } from "./model"

const temporary: string[] = []
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "stillon-updater-")); temporary.push(root); return root }

function deployment(root: string): UpdateDeployment {
  return { schema: 1, platform: "win32", architecture: "arm64", root, controller: path.join(root, "controller.js"),
    port: 3210, dataRoot: path.join(root, "profile", ".stillon"), launch: {
      executable: process.execPath, args: [path.join(root, "old", "bin", "stillon"), "--no-open", "--strict-port", "--port", "3210"],
      workingDirectory: path.join(root, "old"), homeDirectory: path.join(root, "profile"), pathEnvironment: "test-path",
    } }
}

describe("platform and architecture selection", () => {
  for (const platform of ["darwin", "win32"] as const) for (const arch of ["x64", "arm64"] as const) {
    test(`${platform}/${arch} retains the running Bun architecture`, () => expect(updateTarget(platform, arch)).toEqual({ platform, architecture: arch }))
  }
  test("unsupported installations stay out of the managed updater", () => {
    expect(() => updateTarget("linux", "arm64")).toThrow("source-upgrade prompt")
    expect(() => updateTarget("win32", "ia32")).toThrow("architecture")
  })
  test("native roots use user directories rather than any developer machine path", () => {
    expect(updateRoot("darwin", "/Users/example")).toBe("/Users/example/Library/Application Support/StillOn/ManagedUpdates")
    expect(updateRoot("win32", "C:\\Users\\example", "D:\\User Data")).toBe("D:\\User Data\\StillOn\\ManagedUpdates")
  })
  test("tags cannot become shell or Git options", () => {
    for (const tag of ["../main", "--upload-pack=bad", "v1.0.0;echo", "v01.2.3", "v1.2.3-beta"]) expect(() => releaseTag(tag)).toThrow()
    expect(newerRelease("v1.10.0", "1.9.9")).toBe(true)
    expect(newerRelease("v1.2.3", "1.2.3")).toBe(false)
    expect(parseUpdateArgs(["request", "1.2.3", "--prepare-only"])).toEqual({ action: "request", tag: "v1.2.3", prepareOnly: true })
    expect(() => parseUpdateArgs(["setup", "--force"])).toThrow()
  })
})

describe("independent native registrations", () => {
  test("Windows x64 and ARM64 both use Task Scheduler and a headless executable", () => {
    for (const architecture of ["x64", "arm64"] as const) {
      const config = deployment("C:\\Users\\example\\AppData\\Local\\StillOn\\ManagedUpdates")
      config.architecture = architecture
      config.launch.executable = "C:\\Program Files\\Bun\\bun.exe"
      config.launch.environmentFile = "C:\\Users\\example\\private'env.env"
      const xml = windowsUpdaterXml(config, "EXAMPLE\\user")
      expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>")
      expect(xml).toContain("--headless powershell.exe")
      expect(xml).toContain("<Interval>PT1M</Interval>")
      expect(xml).toContain("<LogonType>InteractiveToken</LogonType>")
      const encoded = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]
      const script = Buffer.from(encoded, "base64").toString("utf16le")
      expect(script).toContain("private''env.env")
      expect(script).toContain("'worker'")
      expect(script).not.toContain("while ($true)")
    }
  })
  test("Mac Intel and Apple Silicon use a distinct persistent LaunchAgent", () => {
    const config = deployment("/Users/example/Library/Application Support/StillOn/ManagedUpdates")
    config.platform = "darwin"
    config.launch.executable = "/Users/example/.bun/bin/bun"
    config.launch.homeDirectory = "/Users/example"
    const xml = macosUpdaterPlist(config)
    expect(xml).toContain("com.bzbj.stillon.updater")
    expect(xml).toContain("<key>StartInterval</key><integer>60</integer>")
    expect(xml).toContain("<key>RunAtLoad</key><true/>")
    expect(xml).toContain("<string>worker</string>")
    expect(xml).not.toContain("bash -c")
  })
})

describe("application shutdown authorization", () => {
  test("the public instance nonce is not a shutdown credential", () => {
    let stopped = false
    const control = createManagedAppControl({ instance: "public-id", secret: "private-key", busy: () => false, shutdown: async () => { stopped = true } })
    for (const token of ["", "public-id"]) {
      expect(control.handle(new Request("http://localhost/_stillon/update/pause", { method: "POST", headers: { Authorization: `Bearer ${token}` } }), "127.0.0.1")?.status).toBe(403)
    }
    expect(stopped).toBe(false)
    expect(control.paused).toBe(false)
  })
  test("active work rejects pause without interrupting it", () => {
    const control = createManagedAppControl({ instance: "id", secret: "key", busy: () => true, shutdown: async () => { throw new Error("must not stop") } })
    const req = new Request("http://localhost/_stillon/update/pause", { method: "POST", headers: { Authorization: "Bearer key" } })
    expect(control.handle(req, "127.0.0.1")?.status).toBe(409)
    expect(control.paused).toBe(false)
  })
  test("verification blocks new work until authenticated resume", () => {
    const control = createManagedAppControl({ instance: "id", secret: "key", verifying: true, busy: () => false, shutdown: async () => {} })
    expect(control.paused).toBe(true)
    const req = new Request("http://localhost/_stillon/update/resume", { method: "POST", headers: { Authorization: "Bearer key" } })
    expect(control.handle(req, "10.0.0.1")?.status).toBe(403)
    expect(control.handle(req, "127.0.0.1")?.status).toBe(200)
    expect(control.paused).toBe(false)
  })
  test("unmanaged servers do not expose updater controls", () => {
    const control = createManagedAppControl({ busy: () => false, shutdown: async () => {} })
    expect(control.instance).toBeUndefined()
    expect(control.handle(new Request("http://localhost/_stillon/update/pause", { method: "POST" }), "127.0.0.1")?.status).toBe(403)
  })
})

async function fixture() {
  const root = await temp()
  const config = deployment(root)
  await mkdir(config.dataRoot, { recursive: true })
  await writeFile(path.join(config.dataRoot, "history.json"), "original")
  await atomicJson(path.join(root, "control.json"), { runtime: config.launch.workingDirectory, paused: false })
  const state = await enqueueUpdate(config, "v0.2.16")
  await claimRequest(config)
  const calls: string[] = []
  const effects: UpdateEffects = {
    prepare: async () => { calls.push("prepare") },
    pause: async () => { calls.push("pause") },
    resume: async (runtime) => {
      calls.push(runtime === state.oldRuntime ? "old" : "new")
      if (runtime === state.newRuntime) {
        await writeFile(path.join(config.dataRoot, "history.json"), "migrated")
        await writeFile(path.join(config.dataRoot, "new-schema.json"), "new")
      }
    },
    verify: async () => { calls.push("verify") },
  }
  return { root, config, state, effects, calls, engine: new UpdateEngine(config, effects) }
}

describe("durable update and recovery", () => {
  test("data backup is complete before starting new code", async () => {
    const f = await fixture()
    const resume = f.effects.resume
    f.effects.resume = async (runtime) => {
      expect(await readFile(path.join(f.root, "transactions", f.state.id, "data", "history.json"), "utf8")).toBe("original")
      expect((await json<UpdateState>(path.join(f.root, "state.json"))).newMayHaveStarted).toBe(true)
      await resume(runtime)
    }
    await f.engine.execute()
    expect(f.engine.state.phase).toBe("succeeded")
    expect(f.calls).toEqual(["prepare", "pause", "new", "verify"])
  })
  test("failed preparation leaves the application and data alone", async () => {
    const f = await fixture()
    f.effects.prepare = async () => { throw new Error("customization conflict") }
    await f.engine.execute()
    expect(f.engine.state.phase).toBe("failed")
    expect(f.calls).toEqual([])
    expect(await readFile(path.join(f.config.dataRoot, "history.json"), "utf8")).toBe("original")
  })
  test("failed new runtime restores old history and preserves migrated data", async () => {
    const f = await fixture()
    f.effects.verify = async (runtime) => { if (runtime === f.state.newRuntime) throw new Error("new app failed") }
    await f.engine.execute()
    expect(f.engine.state.phase).toBe("rolled-back")
    expect(await readFile(path.join(f.config.dataRoot, "history.json"), "utf8")).toBe("original")
    expect(await Bun.file(path.join(f.config.dataRoot, "new-schema.json")).exists()).toBe(false)
    expect(await readFile(path.join(path.dirname(f.config.dataRoot), `.stillon-after-failed-${f.state.id}`, "history.json"), "utf8")).toBe("migrated")
  })
  test("new worker recovers a persisted interruption before backup", async () => {
    const f = await fixture()
    await atomicJson(path.join(f.root, "state.json"), { ...f.state, phase: "pausing" })
    await new UpdateEngine(f.config, f.effects).execute()
    expect((await json<UpdateState>(path.join(f.root, "state.json"))).phase).toBe("rolled-back")
    expect(f.calls).toEqual(["pause", "old", "verify"])
  })
  test("interrupted preparation is not retried over a partially built tree", async () => {
    const f = await fixture()
    await atomicJson(path.join(f.root, "state.json"), { ...f.state, phase: "preparing" })
    await f.engine.execute()
    expect(f.engine.state.phase).toBe("failed")
    expect(f.calls).toEqual([])
  })
  test("a corrupt backup leaves recovery pending and never launches old code on migrated data", async () => {
    const f = await fixture()
    const data = path.join(f.root, "transactions", f.state.id, "data")
    const backup = await copyTree(f.config.dataRoot, data)
    await atomicJson(path.join(f.root, "transactions", f.state.id, "data-manifest.json"), backup)
    await writeFile(path.join(data, "history.json"), "corrupt")
    await atomicJson(path.join(f.root, "state.json"), { ...f.state, phase: "starting", backupReady: true, dataExisted: true, newMayHaveStarted: true })
    await expect(f.engine.execute()).rejects.toThrow("checksum")
    expect(f.engine.state.phase).toBe("recovery-required")
    expect(f.calls).not.toContain("old")
  })
  test("request claiming is idempotent across a crash between journal and unlink", async () => {
    const f = await fixture()
    await atomicJson(path.join(f.root, "request.json"), f.state)
    await claimRequest(f.config)
    expect(await Bun.file(path.join(f.root, "request.json")).exists()).toBe(false)
    expect((await json<UpdateState>(path.join(f.root, "state.json"))).id).toBe(f.state.id)
    await expect(enqueueUpdate(f.config, "v0.2.17")).rejects.toThrow("already pending")
  })
  test("paths and backup destinations cannot overwrite existing data", async () => {
    const f = await fixture()
    expect(() => inside(f.root, "../escape")).toThrow()
    await expect(copyTree(f.config.dataRoot, f.config.dataRoot)).rejects.toThrow("overwrite")
    expect(Object.keys(await manifest(f.config.dataRoot))).toEqual(["history.json"])
  })
})
