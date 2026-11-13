import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BUNDLE_FILE } from "../distribution/bundle"
import { atomicJson, exists, json } from "./files"
import { updateTarget, type UpdateDeployment, type UpdateState } from "./model"
import { pruneManagedStorage, RETENTION_FILE } from "./retention"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const DAY = 24 * 60 * 60 * 1000
const longAgo = new Date(Date.now() - 10 * DAY)

/** Age a tree so the recent-write guard does not apply. */
async function age(entry: string) {
  for (const name of await readdir(entry, { recursive: true })) await utimes(path.join(entry, String(name)), longAgo, longAgo)
  await utimes(entry, longAgo, longAgo)
}

async function packageRuntime(root: string, relative: string) {
  const runtime = path.join(root, "releases", relative)
  await mkdir(path.join(runtime, "runtime"), { recursive: true })
  await writeFile(path.join(runtime, BUNDLE_FILE), "{}")
  await writeFile(path.join(runtime, "runtime", "bun"), "bun")
  await age(path.join(root, "releases", relative.split("/")[0]!))
  return runtime
}

async function transaction(root: string, id: string, phase: string, ageDays: number) {
  const directory = path.join(root, "transactions", id)
  await mkdir(path.join(directory, "data"), { recursive: true })
  await mkdir(path.join(directory, "probe"), { recursive: true })
  await writeFile(path.join(directory, "data", "chats.jsonl"), "{}")
  await atomicJson(path.join(directory, "journal.json"), { id, phase })
  const at = new Date(Date.now() - ageDays * DAY)
  await utimes(path.join(directory, "journal.json"), at, at)
}

async function installation() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-retention-"))
  roots.push(root)
  const current = await packageRuntime(root, "desktop-current")
  const previous = await packageRuntime(root, "id-previous/v1.0.0")
  const stale = await packageRuntime(root, "id-stale/v0.9.0")
  const staleFlat = await packageRuntime(root, "desktop-stale")
  const running = await packageRuntime(root, "desktop-running")
  const recent = path.join(root, "releases", "desktop-recent")
  await mkdir(recent, { recursive: true })
  await writeFile(path.join(recent, BUNDLE_FILE), "{}")
  // A source runtime holds the user's customizations; it is never removed.
  const source = path.join(root, "releases", "id-source", "v0.8.0")
  await mkdir(path.join(source, ".git"), { recursive: true })
  await age(path.join(root, "releases", "id-source"))
  for (const name of ["desktop-current", "desktop-old"]) {
    await mkdir(path.join(root, "controllers", name), { recursive: true })
    await writeFile(path.join(root, "controllers", name, "controller.js"), "//")
    await age(path.join(root, "controllers", name))
  }
  // Retention is platform-neutral; any supported target works on every CI host.
  const deployment: UpdateDeployment = { schema: 1, ...updateTarget("darwin", "arm64"), root, controller: path.join(root, "controllers", "desktop-current", "controller.js"),
    dataRoot: path.join(root, "home", ".stillon"), port: 1,
    launch: { executable: path.join(root, "controllers", "desktop-current", "bun"), workingDirectory: current, homeDirectory: path.join(root, "home"),
      pathEnvironment: "", args: [path.join(current, "bin", "stillon")] } }
  await atomicJson(path.join(root, "deployment.json"), deployment)
  await atomicJson(path.join(root, "control.json"), { runtime: current, paused: false })
  await atomicJson(path.join(root, "runner.json"), { runtime: current, stopped: false, instance: "i", secret: "s" })
  const state: UpdateState = { id: "t-current", phase: "succeeded", targetTag: "v1.1.0", prepareOnly: false,
    oldRuntime: previous, newRuntime: current, updatedAt: new Date().toISOString() }
  await atomicJson(path.join(root, "state.json"), state)
  await atomicJson(path.join(root, "build-manifests.json"), { [current]: {}, [stale]: {}, [staleFlat]: {} })
  await transaction(root, "t-current", "succeeded", 1)
  await transaction(root, "t-1", "succeeded", 3)
  await transaction(root, "t-2", "rolled-back", 5)
  await transaction(root, "t-3", "succeeded", 7)
  await transaction(root, "t-4", "failed", 9)
  return { root, deployment, current, previous, stale, staleFlat, running, recent, source }
}

test("keeps the current and previous runtimes and removes only old package runtimes", async () => {
  const f = await installation()
  const result = await pruneManagedStorage(f.deployment, { commandLines: async () => [`bun ${f.running}/bin/stillon`] })
  expect(result.skipped).toBeUndefined()
  expect(result.failures).toEqual([])
  expect(result.removedReleases.sort()).toEqual(["desktop-stale", "id-stale"])
  for (const kept of [f.current, f.previous, f.running, f.recent, f.source]) expect(await exists(kept)).toBe(true)
  expect(result.removedControllers).toEqual(["desktop-old"])
  expect(await exists(path.dirname(f.deployment.controller))).toBe(true)
  // The two most recent finished transactions keep their backups; journals always stay.
  expect(result.removedTransactionData.sort()).toEqual(["t-3/data", "t-3/probe", "t-4/data", "t-4/probe"])
  expect(await exists(path.join(f.root, "transactions", "t-1", "data"))).toBe(true)
  expect(await exists(path.join(f.root, "transactions", "t-2", "data"))).toBe(true)
  expect(await exists(path.join(f.root, "transactions", "t-current", "data"))).toBe(true)
  expect(await exists(path.join(f.root, "transactions", "t-4", "journal.json"))).toBe(true)
  expect(Object.keys(await json(path.join(f.root, "build-manifests.json")))).toEqual([f.current])
  expect((await readdir(path.join(f.root, "releases"))).some((name) => name.startsWith(".retired-"))).toBe(false)
})

test("the previous active runtime survives a later failed update", async () => {
  const f = await installation()
  await pruneManagedStorage(f.deployment, { commandLines: async () => [] })
  expect((await json<{ active: string[] }>(path.join(f.root, RETENTION_FILE))).active).toEqual([f.previous, f.current])
  const candidate = await packageRuntime(f.root, "id-candidate/v1.2.0")
  await atomicJson(path.join(f.root, "state.json"), { id: "t-next", phase: "failed", targetTag: "v1.2.0", prepareOnly: false,
    oldRuntime: f.current, newRuntime: candidate, updatedAt: new Date().toISOString() } satisfies UpdateState)
  await pruneManagedStorage(f.deployment, { commandLines: async () => [] })
  expect(await exists(f.previous)).toBe(true)
  expect(await exists(f.current)).toBe(true)
})

test("after a switch the runtime before the previous one is removed", async () => {
  const f = await installation()
  await pruneManagedStorage(f.deployment, { commandLines: async () => [] })
  const next = await packageRuntime(f.root, "id-next/v1.2.0")
  await atomicJson(path.join(f.root, "control.json"), { runtime: next, paused: false })
  await atomicJson(path.join(f.root, "runner.json"), { runtime: next, stopped: false, instance: "i", secret: "s" })
  await atomicJson(path.join(f.root, "state.json"), { id: "t-next", phase: "succeeded", targetTag: "v1.2.0", prepareOnly: false,
    oldRuntime: f.current, newRuntime: next, updatedAt: new Date().toISOString() } satisfies UpdateState)
  // The deployment launch still names the original package; reference it elsewhere.
  await atomicJson(path.join(f.root, "deployment.json"), { ...f.deployment, launch: { ...f.deployment.launch, workingDirectory: next, args: [path.join(next, "bin", "stillon")] } })
  const result = await pruneManagedStorage(f.deployment, { commandLines: async () => [] })
  expect(result.removedReleases).toEqual(["id-previous"])
  expect(await exists(f.current)).toBe(true)
  expect(await exists(next)).toBe(true)
})

test("nothing is removed while an update is pending or the process table is unreadable", async () => {
  const f = await installation()
  await atomicJson(path.join(f.root, "state.json"), { id: "t-next", phase: "verifying", targetTag: "v1.2.0", prepareOnly: false,
    oldRuntime: f.current, newRuntime: f.stale, updatedAt: new Date().toISOString() } satisfies UpdateState)
  expect((await pruneManagedStorage(f.deployment, { commandLines: async () => [] })).skipped).toContain("in progress")
  await atomicJson(path.join(f.root, "state.json"), { id: "t-current", phase: "succeeded", targetTag: "v1.1.0", prepareOnly: false,
    oldRuntime: f.previous, newRuntime: f.current, updatedAt: new Date().toISOString() } satisfies UpdateState)
  await writeFile(path.join(f.root, "request.json"), "{}")
  expect((await pruneManagedStorage(f.deployment, { commandLines: async () => [] })).skipped).toContain("request")
  await rm(path.join(f.root, "request.json"))
  const unreadable = await pruneManagedStorage(f.deployment, { commandLines: async () => { throw new Error("ps failed") } })
  expect(unreadable.skipped).toContain("process table")
  expect(await exists(f.stale)).toBe(true)
  expect(await exists(f.staleFlat)).toBe(true)
})
