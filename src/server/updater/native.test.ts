import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServiceCommandResult, ServiceCommandRunner } from "../service/types"
import { installUpdateWorker } from "./native"
import type { UpdateDeployment } from "./model"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function deployment(): Promise<UpdateDeployment> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-worker-registration-")); roots.push(root)
  return { schema: 1, platform: "darwin", architecture: "arm64", root, controller: path.join(root, "controller.js"),
    port: 3210, dataRoot: path.join(root, ".stillon"), launch: {
      executable: process.execPath, args: [], workingDirectory: root, homeDirectory: root, pathEnvironment: process.env.PATH ?? "",
    } }
}
const result = (code = 0, stderr = ""): ServiceCommandResult => ({ code, stderr, stdout: "", signal: null })

test("worker replacement waits for asynchronous launchd removal before bootstrap", async () => {
  const calls: string[] = []
  const responses = [result(), result(), result(), result(), result(113), result()]
  const run: ServiceCommandRunner = async (_command, args) => {
    calls.push(args[0]!)
    const response = responses.shift()
    if (!response) throw new Error("Unexpected launchctl call")
    if (args[0] === "bootstrap") expect(responses).toHaveLength(0)
    return response
  }
  await installUpdateWorker(await deployment(), run)
  expect(calls).toEqual(["print", "bootout", "print", "print", "print", "bootstrap"])
})

test("worker replacement refuses to bootstrap after an unload inspection failure", async () => {
  const calls: string[] = []
  const responses = [result(), result(), result(1, "Operation not permitted")]
  const run: ServiceCommandRunner = async (_command, args) => {
    calls.push(args[0]!); return responses.shift()!
  }
  await expect(installUpdateWorker(await deployment(), run)).rejects.toThrow("Operation not permitted")
  expect(calls).toEqual(["print", "bootout", "print"])
})

test("worker bootstrap failure retains launchctl diagnostics", async () => {
  const run: ServiceCommandRunner = async (_command, args) => args[0] === "print"
    ? result(113) : result(5, "Bootstrap failed: 5: Input/output error")
  await expect(installUpdateWorker(await deployment(), run)).rejects.toThrow("Register updater failed (exit code 5): Bootstrap failed: 5: Input/output error")
})
