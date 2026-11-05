import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

// An opt-in packaged-runtime check. Never installs a service or uses a real home.
if (process.argv[2] === "--child") {
  const runtime = path.resolve(process.argv[3]!), root = path.resolve(process.argv[4]!)
  const { startStillOnServer } = await import(pathToFileURL(path.join(runtime, "src/server/server.ts")).href)
  const options = { port: 0, host: "127.0.0.1", strictPort: true, openBrowser: false,
    dataDir: path.join(root, "data"), discoveryHome: path.join(root, "empty-discovery") }
  let app = await startStillOnServer(options)
  const snapshot = async () => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/addons`)
    assert.equal(response.status, 200); return response.json()
  }
  const change = async (id: string, action: string) => {
    const origin = `http://127.0.0.1:${app.port}`
    const response = await fetch(`${origin}/api/addons`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) })
    assert.equal(response.status, 200, await response.text())
  }
  try {
    const fresh = await snapshot()
    assert.deepEqual(fresh.addons.map((item: any) => [item.id, item.enabled, item.bundled]), [["deepseek", false, true], ["codebuddy", false, true]])
    assert.deepEqual(fresh.providers.map((item: any) => item.id), ["claude", "codex"])
    const html = await (await fetch(`http://127.0.0.1:${app.port}/settings/integrations`)).text()
    assert(html.includes("<html"), "packaged settings shell must be served")
    if (fresh.addons.every((item: any) => item.compatible)) {
      await change("deepseek", "enable"); await change("codebuddy", "enable"); await change("deepseek", "disable")
      assert.deepEqual((await snapshot()).providers.map((item: any) => item.id), ["claude", "codex", "codebuddy"])
      // Real host restart with the same isolated data. No vendor process is needed.
      await app.stop(); app = await startStillOnServer(options)
      assert.deepEqual((await snapshot()).addons.map((item: any) => [item.id, item.enabled]), [["deepseek", false], ["codebuddy", true]])
      await change("codebuddy", "disable")
    }
    console.log("PASS: packaged server includes both disabled integrations; owner toggles and restart persistence work without source builds or vendor CLIs.")
  } finally { await app.stop() }
  process.exit(0)
} else {
  const root = path.resolve("test-artifacts/bundled-runtime", crypto.randomUUID()), home = path.join(root, "home")
  await mkdir(home, { recursive: true })
  const { verifyBundle, unpackBundle, artifactName, bunRelativePath } = await import("../src/server/distribution/bundle")
  const { updateTarget } = await import("../src/server/updater/model")
  const target = updateTarget(), runtime = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "extracted runtime")
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()
  // Exercise the archive's regular files, not Bun install's staging hardlinks.
  const manifest = process.argv[2] ? await verifyBundle(runtime, target) : await unpackBundle(
    await Bun.file(path.resolve("dist/desktop/release", artifactName(pkg.version, target.platform, target.architecture))).bytes(), runtime, target)
  for (const id of ["deepseek", "codebuddy"]) {
    const file = `dist/integrations/${id}.stillon-addon`
    assert(file in manifest.files, "adapter must be sealed in desktop runtime manifest")
    const bundle = JSON.parse(await readFile(path.join(runtime, file), "utf8"))
    assert.equal(bundle.manifest.id, id)
  }
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData/Local") }
  for (const key of Object.keys(environment)) if (/^(STILLON_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|DSH_|DEEPSEEK_|CODEBUDDY_|NODE_OPTIONS$|BUN_OPTIONS$)/iu.test(key)) delete environment[key]
  environment.PATH = process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin"
  const child = Bun.spawn([path.join(runtime, bunRelativePath(target.platform)), "--no-env-file", import.meta.path, "--child", runtime, root], {
    cwd: root, env: environment, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  const exit = await child.exited
  assert.equal(exit, 0, "packaged integration acceptance failed")
  console.log(`Isolated artifacts: ${root}`)
}
