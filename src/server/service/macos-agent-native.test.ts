import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "darwin")("native owner reaps fast children and forwards termination without replacing itself", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-native-agent-"))
  try {
    const binary = path.join(root, "StillOn Agent")
    const compiler = Bun.spawn(["/usr/bin/clang", "-Wall", "-Wextra", "-Werror", path.resolve(import.meta.dir, "../../../packaging/macos/agent-helper.c"), "-o", binary], { stderr: "pipe" })
    expect(await compiler.exited).toBe(0)
    async function run(args: string[]) {
      const child = Bun.spawn([binary, ...args], { timeout: 2000, killSignal: "SIGKILL", stderr: "ignore" })
      return child.exited
    }
    expect(await run([])).toBe(64)
    expect(await run(["/bin/sh", "-c", "exit 23"])).toBe(23)
    expect(await run(["/bin/sh", "-c", "kill -TERM $$"])).toBe(143)
    for (let i = 0; i < 25; i++) expect(await run(["/usr/bin/true"])).toBe(0)
    const child = Bun.spawn([binary, "/bin/sleep", "30"], { timeout: 2000, killSignal: "SIGKILL" })
    await Bun.sleep(100)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

test.skipIf(process.platform !== "darwin")("native owner escalates a controller ignoring SIGTERM and reaps it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-agent-timeout-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let controllerPid: number | undefined
  try {
    const binary = path.join(root, "StillOn Agent")
    const compiler = Bun.spawn(["/usr/bin/clang", "-Wall", "-Wextra", "-Werror", "-DSTILLON_TERMINATION_TIMEOUT=1", path.resolve(import.meta.dir, "../../../packaging/macos/agent-helper.c"), "-o", binary])
    expect(await compiler.exited).toBe(0)
    const running = Bun.spawn([binary, "/bin/sh", "-c", "trap '' TERM; echo $$; while :; do :; done"], { stdout: "pipe", timeout: 5000, killSignal: "SIGKILL" })
    child = running
    const reader = running.stdout.getReader()
    const ready = await reader.read()
    const pid = Number(new TextDecoder().decode(ready.value).trim())
    controllerPid = pid
    expect(pid).toBeGreaterThan(0)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(137)
    expect(() => process.kill(pid, 0)).toThrow()
    reader.releaseLock()
  } finally {
    child?.kill("SIGKILL")
    if (controllerPid) { try { process.kill(controllerPid, "SIGKILL") } catch {} }
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
