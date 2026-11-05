import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, stat, symlink, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { APPLICATION_LOG_BYTES, APPLICATION_LOG_COUNT, applicationFailure, captureApplicationStderr, recordApplicationExit } from "./startup-diagnostics"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "stillon-startup-")); roots.push(root); return root }

test("port conflicts identify the startup log without exposing raw stderr", async () => {
  const root = await temp()
  const log = path.join(root, "application-logs", "fixture.stderr.log")
  await Bun.write(log, 'private-token=do-not-display\nerror: EADDRINUSE\n')
  await recordApplicationExit(root, "candidate", 1, log)
  expect(await applicationFailure(root, "candidate")).toContain("EADDRINUSE")
  expect(await applicationFailure(root, "candidate")).toContain("fixture.stderr.log")
  expect(await applicationFailure(root, "candidate")).not.toContain("private-token")
  expect(await applicationFailure(root, "another runtime")).toBeNull()
})

test("missing diagnostics and missing log files do not mask the health failure", async () => {
  const root = await temp()
  expect(await applicationFailure(root, "candidate")).toBeNull()
  await recordApplicationExit(root, "candidate", 2, path.join(root, "missing.stderr.log"))
  expect(await applicationFailure(root, "candidate")).toContain("code 2")
})

test("stderr capture retains a bounded private tail and keeps logs cited by recovery", async () => {
  const root = await temp()
  async function capture(instance: string, contents: string) {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(contents)); controller.close() } })
    const log = captureApplicationStderr(root, instance, stream)
    await log.finished
    return log.file
  }
  const original = await capture("original", "initial startup failure")
  // Ensure this cited log falls outside the newest logs even when Windows
  // timestamps several rapid writes identically. Its retention must be due
  // to the recovery reference, rather than its incidental sort position.
  await utimes(original, new Date(0), new Date(0))
  await Bun.write(path.join(root, "state.json"), JSON.stringify({ error: "see application-logs/original.stderr.log" }))
  for (let i = 0; i < APPLICATION_LOG_COUNT + 2; i++) await capture(`restart-${i}`, "retry")
  const latest = await capture("latest", "x".repeat(APPLICATION_LOG_BYTES * 2) + "\nEADDRINUSE\n")
  expect((await stat(latest)).size).toBe(APPLICATION_LOG_BYTES)
  expect(await Bun.file(latest).text()).toEndWith("EADDRINUSE\n")
  expect(await Bun.file(original).text()).toBe("initial startup failure")
  expect((await readdir(path.dirname(latest))).length).toBe(APPLICATION_LOG_COUNT + 1)
  if (process.platform !== "win32") expect((await stat(latest)).mode & 0o777).toBe(0o600)
})

test("stderr logging failure still drains the application pipe", async () => {
  const root = await temp()
  await Bun.write(path.join(root, "application-logs"), "not a directory")
  let drained = false
  const log = captureApplicationStderr(root, "fixture", new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("application output")); },
    pull(controller) { drained = true; controller.close() },
  }))
  await log.finished
  expect(drained).toBe(true)
})

test("an inherited stderr pipe cannot hold up recovery after the application exits", async () => {
  const root = await temp()
  let cancelled = false
  const log = captureApplicationStderr(root, "inherited", new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("startup failure")) },
    cancel() { cancelled = true },
  }))
  await log.finish()
  expect(cancelled).toBe(true)
  expect(await Bun.file(log.file).text()).toBe("startup failure")
}, 3_000)

test("malformed exit metadata and untrusted paths never enter update status", async () => {
  const root = await temp(), record = path.join(root, "application-exit.json")
  await Bun.write(record, '{"private-token":"do-not-display"')
  expect(await applicationFailure(root, "candidate")).toBeNull()
  await recordApplicationExit(root, "candidate", 1, path.join(root, "private-token.stderr.log"))
  expect(await applicationFailure(root, "candidate")).toBe("application exited with code 1")
  await Bun.write(record, JSON.stringify({ runtime: "candidate", exitCode: "private-token", stderrLog: 123 }))
  expect(await applicationFailure(root, "candidate")).toBe("application exited with code unknown")
})

test.skipIf(process.platform === "win32")("a linked diagnostic log is not read", async () => {
  const root = await temp(), outside = path.join(root, "private.txt")
  const log = captureApplicationStderr(root, "fixture", new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }))
  await log.finished
  await Bun.write(outside, "private-token EADDRINUSE")
  await rm(log.file)
  await symlink(outside, log.file)
  await recordApplicationExit(root, "candidate", 1, log.file)
  expect(await applicationFailure(root, "candidate")).not.toContain("EADDRINUSE")
})
