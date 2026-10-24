import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { startStillOnServer } from "../src/server/server"
import { createCliUpdateFixture } from "./provider-cli-update-fixture"
import type { ProviderCliUpdateStatus } from "../src/shared/provider-cli-updates"

await mkdir("test-artifacts", { recursive: true })
const root = await mkdtemp(path.resolve("test-artifacts/provider-cli-local-"))
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
process.env.HOME = process.env.USERPROFILE = root
process.env.CODEX_HOME = path.join(root, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(root, ".claude")
process.env.STILLON_MACHINE_NAME = "Test computer"
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"]) delete process.env[key]
const engine = await createCliUpdateFixture(path.join(root, "npm"))
const serverOptions = { port: 0, strictPort: true, dataDir: path.join(root, "data"), discoveryHome: root, providerCliUpdates: engine.options }
let server = await startStillOnServer(serverOptions)
const origin = `http://127.0.0.1:${server.port}`, endpoint = `${origin}/api/provider-cli-updates/codex`
async function status(): Promise<ProviderCliUpdateStatus> { const response = await fetch(endpoint); assert.equal(response.status, 200); return response.json() }
try {
  if (process.argv.includes("--browser")) {
    console.log(`Browser fixture: ${origin}/settings/providers`)
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10 * 60_000)
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { clearTimeout(timer); resolve() })
    })
  } else {
    const before = await status()
    assert.equal(before.installation, "npm"); assert.equal(before.currentVersion, "1.2.3"); assert.ok(before.updateToken)
    assert.equal(await engine.installed(), "1.2.3")
    const response = await fetch(endpoint, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ updateToken: before.updateToken }) })
    assert.equal(response.status, 202, await response.text())
    let done = await status()
    for (let attempt = 0; attempt < 50 && done.operation?.state === "updating"; attempt++) { await Bun.sleep(200); done = await status() }
    assert.equal(done.operation?.state, "succeeded", done.operation?.message ?? "Missing operation")
    assert.equal(done.currentVersion, "1.2.4"); assert.equal(done.executable, before.executable)
    assert.equal(await readFile(engine.calls, "utf8"), "install\n")
    assert.equal((await status()).updateAvailable, false)
    const operationId = done.operation!.id
    await server.stop()
    server = await startStillOnServer({ ...serverOptions, port: server.port })
    const restarted = await status()
    assert.equal(restarted.operation?.id, operationId)
    assert.equal(restarted.operation?.state, "succeeded")
    assert.equal(restarted.currentVersion, "1.2.4")
    assert.equal(await readFile(engine.calls, "utf8"), "install\n")
    await writeFile(path.join(root, "accepted.txt"), "PASS")
    console.log("PASS: local status → exact-version npm update in existing prefix → fresh App Server initialize/initialized + model/list → reload and server restart preserve the result without reinstalling; no real CLI changed")
  }
} finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
