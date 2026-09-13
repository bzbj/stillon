import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { atomicJson, exists, json } from "./files"
import { launchAllowed } from "./control"
import { enqueueUpdate } from "./engine"
import { runSetupTransaction, type SetupEffects, type SetupState } from "./setup"
import type { UpdateDeployment } from "./model"
import { hashServiceFile, verifyServiceRegistration, windowsServiceCommand, windowsServiceHash } from "./registration"
import { encodeWindowsTaskXml } from "../service/windows"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(phase: SetupState["phase"] = "queued") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-setup-")); roots.push(root)
  const deployment: UpdateDeployment = { schema: 1, platform: "win32", architecture: "x64", root, controller: path.join(root, "controller.js"),
    port: 3210, dataRoot: path.join(root, "home/.stillon"), launch: { executable: process.execPath, args: [],
      workingDirectory: path.join(root, "runtime"), homeDirectory: path.join(root, "home"), pathEnvironment: "" } }
  await mkdir(deployment.dataRoot, { recursive: true })
  await writeFile(path.join(deployment.dataRoot, "history.json"), "original")
  const file = path.join(root, "setup.json")
  const state: SetupState = { phase, registration: { schema: 1, platform: "win32", launch: deployment.launch,
    serviceFile: path.join(root, "service.xml"), serviceHash: "fixture" }, updatedAt: new Date().toISOString() }
  await atomicJson(file, state)
  const calls: string[] = []
  const effects: SetupEffects = { check: async () => { calls.push("check") }, install: async () => { calls.push("install") },
    verify: async () => { calls.push("verify") }, restore: async () => { calls.push("restore") } }
  return { root, deployment, file, calls, effects }
}

test("first-time service adoption journals before mutation and enables only after verification", async () => {
  const f = await fixture()
  f.effects.install = async () => { expect((await json<SetupState>(f.file)).phase).toBe("installing"); f.calls.push("install") }
  f.effects.verify = async () => { expect((await json<SetupState>(f.file)).phase).toBe("verifying"); f.calls.push("verify") }
  expect(await runSetupTransaction(f.deployment, f.effects)).toBe(true)
  expect(f.calls).toEqual(["check", "install", "verify"])
  expect((await json<SetupState>(f.file)).phase).toBe("enabled")
})

test("busy or changed original services are left intact", async () => {
  const f = await fixture()
  f.effects.check = async () => { throw new Error("service changed") }
  expect(await runSetupTransaction(f.deployment, f.effects)).toBe(false)
  expect(f.calls).toEqual([])
  expect((await json<SetupState>(f.file)).phase).toBe("failed")
})

for (const phase of ["installing", "verifying", "restoring", "recovery-required"] as const) {
  test(`fresh worker restores the original service after setup interruption at ${phase}`, async () => {
    const f = await fixture(phase)
    expect(await launchAllowed(f.root)).toBe(false)
    expect(await runSetupTransaction(f.deployment, f.effects)).toBe(false)
    expect(f.calls).toEqual(["restore"])
    expect((await json<SetupState>(f.file)).phase).toBe("restored")
    expect(await Bun.file(path.join(f.deployment.dataRoot, "history.json")).text()).toBe("original")
  })
}

test("failed recovery stays retryable without repeating service adoption", async () => {
  const f = await fixture("verifying")
  f.effects.restore = async () => { f.calls.push("restore"); throw new Error("scheduler unavailable") }
  await expect(runSetupTransaction(f.deployment, f.effects)).rejects.toThrow("scheduler unavailable")
  expect(f.calls).toEqual(["restore"])
  expect((await json<SetupState>(f.file)).phase).toBe("recovery-required")
  f.effects.restore = async () => { f.calls.push("restore") }
  await runSetupTransaction(f.deployment, f.effects)
  expect((await json<SetupState>(f.file)).phase).toBe("restored")
})

test("app upgrade requests cannot bypass incomplete first-time setup", async () => {
  const f = await fixture("verifying")
  await expect(enqueueUpdate(f.deployment, "v0.3.0")).rejects.toThrow("setup must finish")
  expect(await exists(path.join(f.root, "request.json"))).toBe(false)
})

test("Task Scheduler edits are rejected even when the saved XML file is unchanged", async () => {
  const f = await fixture()
  const setup = await json<SetupState>(f.file)
  await writeFile(setup.registration.serviceFile, "saved definition")
  let native = "<Task><Actions>original</Actions></Task>"
  const run = async () => ({ code: 0, signal: null, stdout: native, stderr: "" })
  const registration = { ...setup.registration, serviceHash: await hashServiceFile(setup.registration.serviceFile), nativeHash: await windowsServiceHash(run) }
  await verifyServiceRegistration(registration, run)
  native = "<Task><Actions>custom launcher</Actions></Task>"
  await expect(verifyServiceRegistration(registration, run)).rejects.toThrow("refusing to replace")
  expect(await Bun.file(registration.serviceFile).text()).toBe("saved definition")
})

test("the original watchdog identity is captured from its installed XML rather than regenerated code", async () => {
  const f = await fixture()
  const file = path.join(f.root, "original.xml")
  const command = Buffer.from("an older registered watchdog", "utf16le").toString("base64")
  await writeFile(file, encodeWindowsTaskXml(`<Task><Arguments>-EncodedCommand ${command}</Arguments></Task>`))
  expect(await windowsServiceCommand(file)).toBe(command)
  await writeFile(file, "<Task><Arguments>custom.exe</Arguments></Task>")
  await expect(windowsServiceCommand(file)).rejects.toThrow("Cannot identify")
})
