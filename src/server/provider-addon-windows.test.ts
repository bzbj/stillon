import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCodeBuddyAddon, buildDeepSeekAddon } from "../../scripts/build-provider-addon"
import { codeBuddyVersion, killCodeBuddyTree, spawnCodeBuddy } from "../../addons/codebuddy/src/codebuddy-cli"
import { deepSeekVersion, killDeepSeekTree, spawnDeepSeek } from "../../addons/deepseek/src/deepseek-cli"
import { ProviderAddons } from "./provider-addons"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test("shipped integrations support both Windows and Mac architectures without opening other platform gates", async () => {
  for (const build of [buildDeepSeekAddon, buildCodeBuddyAddon]) {
    expect((await build()).manifest.targets).toEqual(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"])
  }
}, 20_000)

test.skipIf(!["win32", "darwin"].includes(process.platform))("bundled Windows ARM update loads beside cached Mac preview versions and preserves enablement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-preview-upgrade-")); roots.push(root)
  const previous = path.join(root, "previous"), current = path.join(root, "current")
  await mkdir(previous); await mkdir(current)
  for (const [build, version] of [[buildDeepSeekAddon, "0.2.0-preview.2"], [buildCodeBuddyAddon, "0.1.0-preview.4"]] as const) {
    const bundle = await build(), old = structuredClone(bundle)
    old.code = old.code.replaceAll(bundle.manifest.version, version)
    old.manifest.version = version
    old.manifest.targets = ["win32-x64", "darwin-x64", "darwin-arm64"]
    old.manifest.sha256 = createHash("sha256").update(old.code).digest("hex")
    await writeFile(path.join(previous, `${old.manifest.id}.stillon-addon`), JSON.stringify(old))
    await writeFile(path.join(current, `${bundle.manifest.id}.stillon-addon`), JSON.stringify(bundle))
  }
  const environment = () => { throw new Error("Upgrade must not launch vendor CLIs") }
  const before = new ProviderAddons(root, environment); await before.initialize(previous)
  const supportedBefore = before.snapshot().every(item => item.compatible)
  if (supportedBefore) await before.change("deepseek", "enable")
  const after = new ProviderAddons(root, environment); await after.initialize(current)
  expect(after.snapshot().map(item => [item.id, item.version, item.compatible, item.enabled])).toEqual([
    ["deepseek", "0.2.0-preview.3", true, supportedBefore], ["codebuddy", "0.1.0-preview.5", true, false],
  ])
  await after.change("codebuddy", "enable")
  const restarted = new ProviderAddons(root, environment); await restarted.initialize(current)
  expect(restarted.providers().map(item => item.id)).toEqual(supportedBefore ? ["deepseek", "codebuddy"] : ["codebuddy"])
  const rollback = new ProviderAddons(root, environment); await rollback.initialize(previous)
  expect(rollback.snapshot().map(item => [item.version, item.enabled])).toEqual([
    ["0.2.0-preview.2", supportedBefore], ["0.1.0-preview.4", true],
  ])
}, 20_000)

test.skipIf(process.platform !== "win32")("unmodified bundled integrations enable and survive restart on the native Windows host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-native-addons-")); roots.push(root)
  const directory = path.join(root, "runtime/dist/integrations")
  await mkdir(directory, { recursive: true })
  for (const build of [buildDeepSeekAddon, buildCodeBuddyAddon]) {
    const bundle = await build()
    await writeFile(path.join(directory, `${bundle.manifest.id}.stillon-addon`), JSON.stringify(bundle))
  }
  const environment = () => { throw new Error("Enabling must not launch a vendor CLI") }
  const manager = new ProviderAddons(root, environment); await manager.initialize(directory)
  expect(manager.snapshot().every(item => item.compatible && !item.enabled)).toBe(true)
  for (const id of ["deepseek", "codebuddy"]) await manager.change(id, "enable")
  const restarted = new ProviderAddons(root, environment); await restarted.initialize(directory)
  expect(restarted.providers().map(item => item.id)).toEqual(["deepseek", "codebuddy"])
  await restarted.change("deepseek", "disable")
  expect(restarted.providers().map(item => item.id)).toEqual(["codebuddy"])
}, 20_000)

test.skipIf(process.platform !== "win32")("Windows public cmd launchers preserve Unicode stdio and workspace paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-launchers-")); roots.push(root)
  const cwd = path.join(root, "workspace 中文 with spaces")
  await mkdir(cwd)
  const script = path.join(cwd, "cli.cjs")
  await writeFile(script, `
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log(process.env.FIXTURE_VERSION); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
  console.log(JSON.stringify({text:JSON.parse(line).text,cwd:process.cwd(),args:process.argv.slice(2)}));
  process.exit(0);
});`)
  for (const [name, version, probe, spawn] of [
    ["dsh", "0.2.1-rc.5", deepSeekVersion, (cli: string, env: NodeJS.ProcessEnv) => spawnDeepSeek(cli, cwd, env)],
    ["codebuddy", "2.180.0", codeBuddyVersion, (cli: string, env: NodeJS.ProcessEnv) => spawnCodeBuddy(cli, ["--print"], cwd, env)],
  ] as const) {
    const launcher = path.join(cwd, `${name}.cmd`)
    await writeFile(launcher, `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n`)
    const env = { ...process.env, FIXTURE_VERSION: version,
      DSH_EXECUTABLE: launcher, CODEBUDDY_EXECUTABLE: launcher }
    expect(await probe(launcher, env)).toBe(version)
    // Exercise the real bundled hello/version contract without rewriting targets.
    const manager = new ProviderAddons(path.join(root, name), () => env)
    await manager.initialize()
    await manager.install(await (name === "dsh" ? buildDeepSeekAddon : buildCodeBuddyAddon)())
    expect(await manager.status(name === "dsh" ? "deepseek" : "codebuddy", true)).toMatchObject({ state: "ready" })
    const child = spawn(launcher, env)
    const output: Buffer[] = [], errors: Buffer[] = []
    child.stdout.on("data", chunk => output.push(chunk)); child.stderr.on("data", chunk => errors.push(chunk))
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}: ${Buffer.concat(errors)}`)))
    })
    child.stdin.end(JSON.stringify({ text: "你好 ARM 🚀" }) + "\n")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Windows CLI fixture did not exit")), 10_000)
      })])
      const frame = JSON.parse(Buffer.concat(output).toString("utf8"))
      expect(frame.text).toBe("你好 ARM 🚀")
      // CI's TEMP can use an 8.3 alias while the child reports the long path.
      expect((await realpath(frame.cwd)).toLowerCase()).toBe((await realpath(cwd)).toLowerCase())
      expect(frame.args).toEqual(name === "dsh" ? ["--profile", "sdk"] : ["--print"])
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.pid) await (name === "dsh" ? killDeepSeekTree : killCodeBuddyTree)(child.pid)
    }
  }
}, 30_000)
