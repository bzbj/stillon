import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentDirectory, agentExecutable, installAgentHelper, runtimeAgentBundle } from "./macos-agent"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-agent-")); roots.push(root)
  const runtime = path.join(root, "runtime"); const home = path.join(root, "home")
  const bundle = runtimeAgentBundle(runtime)
  await mkdir(path.join(bundle, "Contents/MacOS"), { recursive: true })
  await writeFile(path.join(bundle, "Contents/Info.plist"), "plist")
  const binary = path.join(bundle, "Contents/MacOS/StillOn Agent")
  await writeFile(binary, "original"); await chmod(binary, 0o755)
  return { runtime, home, bundle, binary }
}
test.skipIf(process.platform === "win32")("helper install is idempotent and replacement preserves the old inode and bytes", async () => {
  const f = await fixture()
  const installed = await installAgentHelper(f.runtime, f.home)
  expect(installed).toBe(agentExecutable(f.home))
  const before = await stat(installed)
  await installAgentHelper(f.runtime, f.home)
  expect((await stat(installed)).ino).toBe(before.ino)
  await writeFile(f.binary, "updated")
  await installAgentHelper(f.runtime, f.home)
  expect(await readFile(installed, "utf8")).toBe("updated")
  const entries = await readdir(agentDirectory(f.home))
  expect(entries.some(name => name.startsWith(".staging-"))).toBe(false)
  const previous = entries.find(name => name.includes(".replaced-"))!
  const old = path.join(agentDirectory(f.home), previous, "Contents/MacOS/StillOn Agent")
  expect((await stat(old)).ino).toBe(before.ino)
  expect(await readFile(old, "utf8")).toBe("original")
  expect((await stat(agentDirectory(f.home))).mode & 0o777).toBe(0o700)
})
test.skipIf(process.platform === "win32")("helper rejects linked runtime content before modifying the installation", async () => {
  const f = await fixture(); await installAgentHelper(f.runtime, f.home)
  await symlink(f.binary, path.join(f.bundle, "linked"))
  await expect(installAgentHelper(f.runtime, f.home)).rejects.toThrow("links")
  expect(await readFile(agentExecutable(f.home), "utf8")).toBe("original")
})
