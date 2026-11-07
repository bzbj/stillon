import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { runServiceCommand } from "../src/server/service"
import { waitForServiceToUnload } from "../src/server/service/macos"
import { installUpdateWorker, type WorkerIdentity } from "../src/server/updater/native"
import type { UpdateDeployment } from "../src/server/updater/model"

// Disposable native registration only: no production labels, homes or ports.
if (process.platform !== "darwin") throw new Error("This rehearsal requires macOS")
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-launchd-rehearsal-"))
const identity: WorkerIdentity = { agent: `com.bzbj.stillon.rehearsal.${randomUUID()}`, task: "unused", mode: "fixture", file: "unused" }
const domain = `gui/${process.getuid!()}`, service = `${domain}/${identity.agent}`
const controller = path.join(root, "worker.ts"), marker = path.join(root, "worker.json")
const checks: string[] = []
const deployment: UpdateDeployment = { schema: 1, platform: "darwin", architecture: process.arch as "x64" | "arm64", root, controller,
  port: 0, dataRoot: path.join(root, "data"), launch: { executable: process.execPath, args: [], workingDirectory: root,
    homeDirectory: root, pathEnvironment: process.env.PATH ?? "" } }
await mkdir(deployment.dataRoot)
await writeFile(path.join(deployment.dataRoot, "history.txt"), "preserved fixture history")
await writeFile(controller, `await Bun.write(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`)
async function waitForWorker(previous?: number) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const { pid } = JSON.parse(await readFile(marker, "utf8"))
      if (pid !== previous) { process.kill(pid, 0); return pid as number }
    } catch { /* startup */ }
    await Bun.sleep(100)
  }
  throw new Error("Native worker did not start")
}
const unloadOptions = { now: Date.now, sleep: (ms: number) => Bun.sleep(ms), pollIntervalMs: 100, timeoutMs: 10_000 }
try {
  await installUpdateWorker(deployment, runServiceCommand, identity)
  const first = await waitForWorker(); checks.push("Native isolated worker bootstrap")
  await installUpdateWorker(deployment, runServiceCommand, identity)
  const second = await waitForWorker(first); checks.push("Replacement waits for launchd removal and starts a new process")
  assert.throws(() => process.kill(first, 0), "Old worker must be gone")
  let injected = false
  await assert.rejects(installUpdateWorker(deployment, async (command, args, options) => {
    if (args[0] === "bootstrap") { injected = true; return { code: 5, signal: null, stdout: "", stderr: "Injected registration failure" } }
    return runServiceCommand(command, args, options)
  }, identity), /Injected registration failure/)
  assert(injected); assert.throws(() => process.kill(second, 0))
  checks.push("Registration failure is reported and no old worker survives")
  await installUpdateWorker(deployment, runServiceCommand, identity)
  await waitForWorker(second); checks.push("Retry after failed registration restores the worker")
  assert.equal(await readFile(path.join(deployment.dataRoot, "history.txt"), "utf8"), "preserved fixture history")
  checks.push("Fixture history preserved")
} finally {
  const loaded = await runServiceCommand("/bin/launchctl", ["print", service])
  if (loaded.code === 0) {
    const stopped = await runServiceCommand("/bin/launchctl", ["bootout", service])
    assert.equal(stopped.code, 0, stopped.stderr)
    await waitForServiceToUnload(runServiceCommand, service, unloadOptions)
  } else assert([3, 113].includes(loaded.code ?? -1), loaded.stderr)
  await rm(root, { recursive: true, force: true })
}
checks.push("Native registration, processes and temporary files removed")
console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, checks }, null, 2))
