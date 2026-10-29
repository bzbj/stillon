import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applicationFailure, recordApplicationExit } from "./startup-diagnostics"
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
