import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readUpdateSettingsSnapshot } from "./settings-snapshot"
import { parseUpdateArgs } from "./cli"
import { updateRoot } from "./model"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "stillon-settings-evidence-")); roots.push(dataRoot)
  await mkdir(path.join(dataRoot, "data"))
  return { dataRoot, file: path.join(dataRoot, "data", "settings.json") }
}

test("the supported snapshot command reads local settings without a live server or mutations", async () => {
  expect(parseUpdateArgs(["settings-snapshot"])).toEqual({ action: "settings-snapshot" })
  expect(() => parseUpdateArgs(["settings-snapshot", "--resume"])).toThrow()
  const f = await fixture()
  const bytes = JSON.stringify({ machineName: "Upgrade fixture", network: { mode: "direct" } })
  await writeFile(f.file, bytes)
  const snapshot = await readUpdateSettingsSnapshot(f)
  expect(snapshot.present).toBe(true)
  expect(snapshot.settings.machineName).toBe("Upgrade fixture")
  expect(await readFile(f.file, "utf8")).toBe(bytes)
})

test("missing settings are explicit evidence, corrupt settings are unavailable rather than a mismatch", async () => {
  const f = await fixture()
  expect((await readUpdateSettingsSnapshot(f)).present).toBe(false)
  for (const content of ["", "{invalid"]) {
    await writeFile(f.file, content)
    await expect(readUpdateSettingsSnapshot(f)).rejects.toThrow("Settings snapshot unavailable")
    expect(await readFile(f.file, "utf8")).toBe(content)
  }
})


test("CLI snapshot uses the recorded data root and never wakes a worker", async () => {
  const f = await fixture()
  await writeFile(f.file, JSON.stringify({ machineName: "CLI upgrade fixture" }))
  const home = path.join(f.dataRoot, "home")
  const localAppData = path.join(home, "AppData", "Local")
  const root = updateRoot(process.platform, home, localAppData)
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "deployment.json"), JSON.stringify({ dataRoot: f.dataRoot }))
  // No controller, service or scheduler exists in this disposable deployment.
  const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve("bin/stillon"), "update", "settings-snapshot"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData },
    stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout).settings.machineName).toBe("CLI upgrade fixture")
  expect(JSON.parse(stdout).present).toBe(true)
})

test("status reports a queued deferred request before the worker journals it", async () => {
  const f = await fixture()
  const home = path.join(f.dataRoot, "home")
  const localAppData = path.join(home, "AppData", "Local")
  const root = updateRoot(process.platform, home, localAppData)
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "deployment.json"), JSON.stringify({ dataRoot: f.dataRoot }))
  const queued = { id: "deferred-transaction", phase: "queued", targetTag: "v9.9.9", prepareOnly: false,
    oldRuntime: "/old", newRuntime: "/new", updatedAt: new Date().toISOString(), idleWaitSeconds: 43_200 }
  await writeFile(path.join(root, "request.json"), JSON.stringify(queued))
  const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve("bin/stillon"), "update", "status"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData },
    stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  const status = JSON.parse(stdout)
  expect(status.update.id).toBe("deferred-transaction")
  expect(status.update.phase).toBe("queued")
  expect(status.update.idleWaitSeconds).toBe(43_200)
})
