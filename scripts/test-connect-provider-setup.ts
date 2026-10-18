import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createConnectFixture, eventually } from "./connect-fixture"
import type { ConnectLocalStatus } from "../src/shared/connect"
import type { ProviderSetupStatus } from "../src/shared/provider-setup"

// Synthetic CLI scripts only; never read a personal provider account or call a model.
await mkdir("test-artifacts/connect", { recursive: true })
const home = await mkdtemp(path.resolve("test-artifacts/connect/provider-home-"))
const bin = path.join(home, "bin")
await mkdir(bin)
for (const key of Object.keys(process.env)) {
  if (/^(CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|STILLON_UPDATE_)/u.test(key) || ["STILLON_RUNTIME_PROFILE", "STILLON_CODEX_APP_EXECUTABLE"].includes(key)) delete process.env[key]
}
Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, "account"), STILLON_AGENT_PATH: bin })
async function cli(file: string, version: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const script = process.platform === "win32"
    ? `@echo off\r\nif "%~1"=="--version" (echo ${version}& exit /b 0)\r\nif "%~1 %~2"=="login status" exit /b 0\r\nexit /b 99\r\n`
    : `#!/bin/sh\ncase "$1 $2" in\n'--version ') printf '%s\\n' '${version}' ;;\n'login status') exit 0 ;;\n*) exit 99 ;;\nesac\n`
  await writeFile(file, script, { mode: 0o700 })
  return file
}
const standalone = await cli(path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex"), "codex-standalone")
const manual = await cli(path.join(home, process.platform === "win32" ? "chosen.cmd" : "chosen"), "codex-manual")
const app = process.platform === "darwin" ? await cli(path.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"), "codex-app") : null
const packageArgument = process.argv.find(argument => argument.startsWith("--cloud-package="))?.slice("--cloud-package=".length)
const packagedCloud = packageArgument ? await import(pathToFileURL(path.resolve(packageArgument, "src/connect/server.ts")).href) : null
const fixture = await createConnectFixture(2, packagedCloud?.startConnectServer).catch(async error => { await rm(home, { recursive: true, force: true }); throw error })
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const bound: ConnectLocalStatus[] = [], sessions: string[] = []
const route = "/api/provider-setup/codex/"
async function local(index: number, action: string, body?: unknown) {
  const origin = `http://127.0.0.1:${fixture.hosts[index]!.port}`
  return fetch(`${origin}${route}${action}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function central(action: string, body: unknown, cookie = "") {
  return fetch(`${fixture.origin}/api/connect/${action}`, { method: "POST", headers: { Origin: fixture.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) })
}
async function remote(index: number, target: string, init: RequestInit = {}) {
  const url = new URL(bound[index]!.url!)
  return fetch(`http://127.0.0.1:${fixture.port}${target}`, { ...init, signal: AbortSignal.timeout(30_000), redirect: "manual",
    headers: { host: url.host, origin: url.origin, cookie: sessions[index] ?? "", ...Object.fromEntries(new Headers(init.headers)) } })
}
async function status(response: Response, executable: string) {
  assert.equal(response.status, 200)
  const value = await response.json() as ProviderSetupStatus
  assert.equal(value.state, "ready", value.message ?? "CLI should be ready")
  assert.equal(value.executable, executable)
  return value
}
try {
  for (let index = 0; index < 2; index++) {
    const origin = `http://127.0.0.1:${fixture.hosts[index]!.port}`
    const enrollment = await eventually(async () => {
      const response = await fetch(`${origin}/api/connect-local/enroll`, { method: "POST", headers: { Origin: origin } })
      return response.ok ? response.json() : null
    }, value => Boolean(value?.id))
    const email = index ? "second@example.com" : "tester@example.com", intent = { purpose: "enroll", id: enrollment.id }
    const pending = await central("request-code", { email, intent })
    assert.equal(pending.status, 200)
    const verified = await central("verify-code", { email, code: fixture.messages.at(-1)!.code, remember: true, intent }, cookies(pending))
    assert.equal(verified.status, 200)
    bound.push(await eventually<ConnectLocalStatus>(async () => (await fetch(`${origin}/api/connect-local/status`)).json(), value => value.state === "online"))
    const redirect = await remote(index, "/_connect/login")
    const flow = new URL(redirect.headers.get("location")!).searchParams.get("flow")
    const authorized = await central("authorize", { flow }, cookies(verified))
    assert.equal(authorized.status, 200)
    const callback = new URL((await authorized.json()).redirect)
    const entered = await remote(index, callback.pathname + callback.search, { headers: { Cookie: cookies(redirect) } })
    assert.equal(entered.status, 303)
    sessions.push(cookies(entered))
  }
  const automatic = app ?? standalone
  for (let index = 0; index < 2; index++) {
    await status(await local(index, "status"), automatic)
    assert.equal((await status(await remote(index, route + "status"), automatic)).canOpenTerminal, false)
  }
  const settings = path.join(fixture.root, "computer-1", "provider-cli.json")
  await status(await local(0, "executable", { executable: manual }), manual)
  await status(await remote(0, route + "status"), manual)
  await status(await local(0, "status"), manual)
  assert.equal(JSON.parse(await readFile(settings, "utf8")).codex, manual)
  await status(await remote(1, route + "status"), automatic)
  const saved = await readFile(settings, "utf8")
  assert.equal((await local(0, "executable", { executable: path.join(home, "missing") })).status, 400)
  // A filesystem write failure must also retain the previously selected CLI.
  await rename(settings, settings + ".saved")
  await mkdir(settings)
  try {
    assert.equal((await local(0, "executable", { executable: standalone })).status, 400)
    await status(await remote(0, route + "status"), manual)
  } finally { await rm(settings, { recursive: true }); await rename(settings + ".saved", settings) }
  for (const action of ["login", "install", "executable"]) {
    const denied = await remote(0, route + action, { method: "POST", ...(action === "executable" ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executable: standalone }),
    } : {}) })
    assert.equal(denied.status, 403, `${action}: ${await denied.text()}`)
  }
  assert.equal((await remote(0, route + "status", { headers: { Cookie: "" } })).status, 401)
  assert.equal((await remote(0, route + "status", { headers: { Cookie: sessions[1]! } })).status, 401)
  assert.equal((await remote(0, route + "status", { headers: { Origin: bound[1]!.url! } })).status, 403)
  assert.equal(await readFile(settings, "utf8"), saved)
  await status(await remote(0, route + "status"), manual)
  await status(await local(0, "executable", { executable: null }), automatic)
  await status(await remote(0, route + "status"), automatic)
  if (app) {
    await rm(app)
    await status(await local(0, "status"), standalone)
    await status(await remote(0, route + "status"), standalone)
    await cli(app, "codex-app-updated")
    assert.equal((await status(await remote(0, route + "status"), app)).version, "codex-app-updated")
    await status(await local(0, "status"), app)
  }
  console.log(JSON.stringify({ passed: true, platform: process.platform, checks: [
    "local and authenticated Connect readiness through gateway, frps/frpc and adapter",
    ...(app ? ["bundled app CLI preferred over PATH; removal and update rediscovered through both entries"] : []),
    "manual override save, cross-entry reload, removal and host isolation",
    "invalid paths and disk write failure retain the selected CLI",
    "remote setup mutations, unauthenticated access, cross-account cookies and cross-origin requests denied",
  ] }, null, 2))
} finally { await fixture.stop(); await rm(home, { recursive: true, force: true }) }
