import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("bundled desktop worker with refreshed PATH reaches the journal without an entry import cycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-controller-entry-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timedOut = false
  try {
    const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, "entry.ts")], outdir: root, naming: "controller.js", target: "bun", packages: "bundle" })
    expect(result.success).toBe(true)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("STILLON_UPDATE_") && !key.startsWith("STILLON_CONNECT_") && key !== "STILLON_RUNTIME_PROFILE"))
    child = Bun.spawn([process.execPath, "--no-env-file", path.join(root, "controller.js"), "desktop-worker", path.join(root, "missing")], {
      env: { ...environment, STILLON_REFRESH_PATH: "1", SHELL: process.platform === "win32" ? environment.SHELL : "/bin/sh" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => { timedOut = true; child?.kill() }, 10_000)
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    clearTimeout(timer)
    expect(timedOut).toBe(false)
    expect(code).not.toBe(0)
    expect(stderr).toContain("desktop-transition.json")
    expect(stderr).toContain("ENOENT")
  } finally {
    if (child?.exitCode === null) { child.kill(); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
