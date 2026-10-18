import assert from "node:assert/strict"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createConnectFixture, eventually } from "./connect-fixture"
import { createCliUpdateFixture } from "./provider-cli-update-fixture"
import type { ConnectLocalStatus } from "../src/shared/connect"
import type { ProviderCliUpdateStatus } from "../src/shared/provider-cli-updates"

for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const isolatedHome = path.resolve("test-artifacts/provider-cli-home")
await mkdir(isolatedHome, { recursive: true })
process.env.HOME = process.env.USERPROFILE = isolatedHome
process.env.CODEX_HOME = path.join(isolatedHome, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(isolatedHome, ".claude")
process.env.STILLON_MACHINE_NAME = "Test computer"
const packaged = process.argv.find(arg => arg.startsWith("--cloud-package="))?.slice("--cloud-package=".length)
const cloud = packaged ? await import(pathToFileURL(path.resolve(packaged, "src/connect/server.ts")).href) : null
const engines: Awaited<ReturnType<typeof createCliUpdateFixture>>[] = []
const fixture = await createConnectFixture(2, cloud?.startConnectServer, async (index, root) => {
  const engine = await createCliUpdateFixture(path.join(root, `cli-${index}`)); engines.push(engine)
  return { providerCliUpdates: engine.options }
})
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const bound: ConnectLocalStatus[] = [], sessions: string[] = [], parents: string[] = []
async function central(route: string, body: unknown, cookie = "") {
  return fetch(`${fixture.origin}/api/connect/${route}`, { method: "POST", headers: { Origin: fixture.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) })
}
async function local(index: number, route: string, body?: unknown) {
  const origin = `http://127.0.0.1:${fixture.hosts[index]!.port}`
  return fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function remote(index: number, route: string, body?: unknown, extra: Record<string, string> = {}) {
  const host = new URL(bound[index]!.url!)
  return fetch(`http://127.0.0.1:${fixture.port}${route}`, { method: body === undefined ? "GET" : "POST", redirect: "manual", headers: { Host: host.host, Origin: host.origin, Cookie: sessions[index] ?? "", "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const route = "/api/provider-cli-updates/codex"
async function status(response: Response): Promise<ProviderCliUpdateStatus> {
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store")
  return response.json()
}
try {
  for (let i = 0; i < 2; i++) {
    const enrollment = await eventually(async () => { const res = await local(i, "/api/connect-local/enroll", {}); return res.ok ? res.json() : null }, value => !!value?.id)
    const email = `cli-tester-${i}@example.com`, intent = { purpose: "enroll", id: enrollment.id }
    const pending = await central("request-code", { email, intent }); assert.equal(pending.status, 200)
    const verified = await central("verify-code", { email, intent, code: fixture.messages.at(-1)!.code, remember: true }, cookies(pending))
    assert.equal(verified.status, 200); parents.push(cookies(verified))
    bound.push(await eventually(async () => (await local(i, "/api/connect-local/status")).json(), value => value.state === "online"))
    const redirect = await remote(i, "/_connect/login")
    const flow = new URL(redirect.headers.get("location")!).searchParams.get("flow")
    const authorized = await central("authorize", { flow }, parents[i]); assert.equal(authorized.status, 200)
    const callback = new URL((await authorized.json()).redirect)
    const entered = await remote(i, callback.pathname + callback.search, undefined, { Cookie: cookies(redirect) })
    assert.equal(entered.status, 303); sessions.push(cookies(entered))
  }
  console.log("PASS: authenticated login gateway, two real tunnels and adapters")
  const first = await status(await local(0, route)), other = await status(await remote(1, route))
  assert.equal(first.currentVersion, "1.2.3"); assert.equal(first.installation, "npm"); assert.ok(first.updateToken)
  assert.equal((await status(await remote(0, route))).updateToken, first.updateToken)
  assert.equal(await engines[0]!.installed(), "1.2.3")
  assert.equal((await remote(0, route, { updateToken: first.updateToken }, { Origin: "https://attacker.example" })).status, 403)
  assert.equal((await remote(0, route, { updateToken: first.updateToken }, { Cookie: sessions[1]! })).status, 401)
  assert.equal((await remote(1, route, { updateToken: first.updateToken })).status, 409)
  console.log("PASS: read-only checks, origin/account/host isolation")
  const updated = await remote(0, route, { updateToken: first.updateToken }); assert.equal(updated.status, 202)
  const done = await eventually(async () => status(await local(0, route)), value => value.operation?.state !== "updating")
  assert.equal(done.operation?.state, "succeeded", done.operation?.message ?? "Missing update operation")
  assert.equal(done.currentVersion, "1.2.4"); assert.equal(done.executable, first.executable)
  assert.equal((await status(await remote(0, route))).currentVersion, "1.2.4")
  assert.equal((await remote(0, route, { updateToken: first.updateToken })).status, 409)
  assert.equal(await readFile(engines[0]!.calls, "utf8"), "install\n")
  assert.equal((await status(await local(1, route))).currentVersion, "1.2.3")
  console.log("PASS: remote update → local verification → remote reload, same npm prefix, fresh App Server and model/list, no replay")
  await writeFile(engines[1]!.failure, "fail")
  assert.equal((await local(1, route, { updateToken: other.updateToken })).status, 202)
  const failed = await eventually(async () => status(await remote(1, route)), value => value.operation?.state !== "updating")
  assert.equal(failed.operation?.state, "failed"); assert.equal(failed.currentVersion, "1.2.3"); assert.equal(failed.executable, other.executable)
  await unlink(engines[1]!.failure)
  assert.equal((await local(1, route, { updateToken: failed.updateToken })).status, 202)
  const retried = await eventually(async () => status(await remote(1, route)), value => value.operation?.state !== "updating")
  assert.equal(retried.operation?.state, "succeeded", retried.operation?.message ?? "Missing retry operation")
  assert.equal(retried.currentVersion, "1.2.4")
  console.log("PASS: local failed update preserves selection/version → remote error/retry → local and remote current version")
} finally { await fixture.stop() }
