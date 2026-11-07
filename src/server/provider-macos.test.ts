import { afterEach, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildBundledIntegrations } from "../../scripts/build-integrations"
import { deepSeekCandidates, deepSeekCommand, killDeepSeekTree, spawnDeepSeek } from "../../addons/deepseek/src/deepseek-cli"
import { ProviderAddons } from "./provider-addons"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-macos-")); roots.push(root)
  return root
}

test("macOS discovery includes both Desktop locations without a login shell", () => {
  const environment = { HOME: "/Users/example", PATH: "" }
  expect(deepSeekCandidates(environment, "darwin")).toEqual([
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    "/Users/example/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  ])
  expect(deepSeekCommand("/Applications/Example's App/cli", ["$(literal)", "a b"], environment, "darwin"))
    .toEqual({ command: "/Applications/Example's App/cli", args: ["$(literal)", "a b"] })
})

test.skipIf(process.platform !== "darwin")("shipped Mac integration enables and retains state across restart without rewriting manifests", async () => {
  const root = await fixture(), directory = path.join(root, "bundled")
  await buildBundledIntegrations(directory)
  const environment = { HOME: root, PATH: "", DSH_EXECUTABLE: path.join(root, "missing-dsh") }
  let manager = new ProviderAddons(root, () => environment); await manager.initialize(directory)
  expect(manager.snapshot().map(addon => [addon.id, addon.compatible, addon.enabled])).toEqual([["deepseek", true, false]])
  await manager.change("deepseek", "enable")
  const status = await manager.status("deepseek", true)
  expect(status.state).toBe("error"); expect(status.message).toContain("missing")
  expect(status.message).not.toContain("platform")
  const legacy = path.join(root, "legacy-dsh")
  await writeFile(legacy, "#!/bin/sh\necho 0.2.1-rc.5\n", { mode: 0o755 })
  environment.DSH_EXECUTABLE = legacy
  expect(await manager.status("deepseek", true)).toMatchObject({ state: "ready", version: "0.2.1-rc.5", executable: legacy })
  await manager.change("deepseek", "disable")
  manager = new ProviderAddons(root, () => environment); await manager.initialize(directory)
  expect(manager.providers().map(provider => provider.id)).toEqual([])
}, 20_000)

for (const provider of ["deepseek"] as const) {
  test.skipIf(process.platform !== "darwin")(`${provider} force-stop kills the owned Mac CLI and its child process`, async () => {
    const root = await fixture(), bin = path.join(root, "public CLI's folder")
    await mkdir(bin)
    const launcher = path.join(bin, "launcher"), script = path.join(bin, "cli.mjs")
    await writeFile(script, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
process.stdin.resume();console.log(child.pid);setInterval(()=>{},1000);`)
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
    await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 })
    const child = spawnDeepSeek(launcher, root, process.env)
    const kill = killDeepSeekTree
    const closed = once(child, "close")
    try {
      const [chunk] = await once(child.stdout, "data"), descendant = Number(String(chunk).trim())
      expect(descendant).toBeGreaterThan(0)
      expect(() => process.kill(descendant, 0)).not.toThrow()
      await kill(child.pid!)
      await closed
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        try { process.kill(descendant, 0) } catch { break }
        await Bun.sleep(20)
      }
      expect(() => process.kill(descendant, 0)).toThrow()
    } finally {
      await kill(child.pid!).catch(() => undefined)
      await closed
    }
  }, 10_000)
}
