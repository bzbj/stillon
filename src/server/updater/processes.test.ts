import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildWindowsServicePowerShell, encodeWindowsPowerShell, getWindowsServicePaths } from "../service/windows"
import { waitUntil } from "./control"
import { exists } from "./files"
import { stopWindowsServiceProcesses } from "./processes"

test.skipIf(process.platform !== "win32")("native service cleanup removes its watchdog and child while leaving a sibling process alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon native '路径-"))
  const marker = path.join(root, "ready.json")
  const entry = path.join(root, "fixture.ts")
  await writeFile(entry, "await Bun.write(process.argv[2],String(process.pid)); setInterval(()=>{},1000)")
  const launch = { executable: process.execPath, args: [entry, marker], workingDirectory: root,
    homeDirectory: root, localAppDataDirectory: path.join(root, "local"), pathEnvironment: process.env.PATH ?? "" }
  await mkdir(getWindowsServicePaths(launch).directory, { recursive: true })
  const sibling = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const watchdog = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeWindowsPowerShell(buildWindowsServicePowerShell(launch))], { windowsHide: true, stdio: "ignore" })
  const watchdogExit = new Promise<void>((resolve, reject) => { watchdog.once("exit", () => resolve()); watchdog.once("error", reject) })
  try {
    await waitUntil(() => exists(marker), 15_000)
    const childPid = Number(await Bun.file(marker).text())
    expect(childPid).toBeGreaterThan(0)
    await stopWindowsServiceProcesses(launch)
    await watchdogExit
    expect(() => process.kill(childPid, 0)).toThrow()
    expect(sibling.exitCode).toBeNull()
  } finally {
    await stopWindowsServiceProcesses(launch)
    sibling.kill()
    await sibling.exited
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
