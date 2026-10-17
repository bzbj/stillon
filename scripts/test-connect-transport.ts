import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createConnectFixture, eventually } from "./connect-fixture"
import { upstreamWebSocket } from "../src/server/connect/relay"
import type { ConnectLocalStatus } from "../src/shared/connect"
import { APPEARANCE_FIXTURE_PNG } from "./appearance-fixture"
import { workspaceAvatarsSchema } from "../src/shared/workspace-avatars"

// No provider requests, real mail, production ports or personal projects.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const packageArgument = process.argv.find(argument => argument.startsWith("--cloud-package="))?.slice("--cloud-package=".length)
const packagedCloud = packageArgument ? await import(pathToFileURL(path.resolve(packageArgument, "src/connect/server.ts")).href) : null
const fixture = await createConnectFixture(2, packagedCloud?.startConnectServer)
console.log("Isolated cloud and two computers started")
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const sockets: WebSocket[] = []
const checks: string[] = []
async function local(index: number, action = "status") {
  const origin = `http://127.0.0.1:${fixture.hosts[index]!.port}`
  return fetch(`${origin}/api/connect-local/${action}`, { method: ["status", "diagnostics"].includes(action) ? "GET" : "POST", headers: { Origin: origin } })
}
async function central(route: string, body?: unknown, cookie = "") {
  return fetch(`${fixture.origin}/api/connect/${route}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: fixture.origin, "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function login(email: string, intent?: { purpose: "enroll"; id: string }) {
  const pending = await central("request-code", { email, ...(intent ? { intent } : {}) })
  assert.equal(pending.status, 200)
  const response = await central("verify-code", { email, code: fixture.messages.at(-1)!.code, remember: true, ...(intent ? { intent } : {}) }, cookies(pending))
  assert.equal(response.status, 200)
  return cookies(response)
}
const bound: ConnectLocalStatus[] = []
const hostCookies: string[] = []
async function host(index: number, route: string, init: RequestInit = {}) {
  const url = new URL(bound[index]!.url!)
  return fetch(`http://127.0.0.1:${fixture.port}${route}`, { ...init, signal: AbortSignal.timeout(30_000), redirect: "manual", headers: { host: url.host, origin: url.origin, cookie: hostCookies[index] ?? "", ...Object.fromEntries(new Headers(init.headers)) } })
}
async function enter(index: number, parent: string) {
  const redirect = await host(index, "/_connect/login")
  const flow = new URL(redirect.headers.get("location")!).searchParams.get("flow")
  const authorized = await central("authorize", { flow }, parent)
  assert.equal(authorized.status, 200)
  const callback = new URL((await authorized.json()).redirect)
  const response = await host(index, callback.pathname + callback.search, { headers: { Cookie: cookies(redirect) } })
  assert.equal(response.status, 303)
  return cookies(response)
}
async function avatarConfig(response: Response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /application\/json/)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const snapshot = await response.json()
  assert.equal(snapshot.warning, undefined)
  return workspaceAvatarsSchema.parse(snapshot.config)
}
async function socket(index: number) {
  const url = new URL(bound[index]!.url!)
  const ws = upstreamWebSocket(`ws://127.0.0.1:${fixture.port}/ws`, new Headers({ Host: url.host, Origin: url.origin, Cookie: hostCookies[index]! }))
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("WebSocket timed out")), 10_000); ws.addEventListener("open", () => { clearTimeout(timeout); resolve() }, { once: true }); ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket failed")) }, { once: true }) })
  return ws
}
async function command(ws: WebSocket, type: object, id = `${Date.now()}-${crypto.randomUUID()}`) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", read); reject(new Error("Command timed out")) }, 5_000)
    const read = (event: MessageEvent) => { const value = JSON.parse(String(event.data)); if (value.id === id) { clearTimeout(timer); ws.removeEventListener("message", read); resolve(value) } }
    ws.addEventListener("message", read); ws.send(JSON.stringify({ v: 1, type: "command", id, command: type }))
  })
}
try {
  assert.equal((await fetch(`${fixture.origin}/ready`)).status, 200)
  const cancelled = await eventually(async () => { const response = await local(0, "enroll"); return response.ok ? response.json() : null }, value => Boolean(value?.id))
  await eventually(async () => { const response = await local(0, "unbind"); return response.ok ? response.json() : null }, value => value?.state === "unbound")
  assert.equal((await central(`enrollments/${cancelled.id}`)).status, 410)
  const diagnostic = await (await local(0, "diagnostics")).json()
  assert.equal(diagnostic.scope, "local-connector"); assert.equal(diagnostic.bound, false)
  for (const value of [fixture.root, fixture.origin, cancelled.id]) assert.equal(JSON.stringify(diagnostic).includes(value), false)
  checks.push("dependency readiness, pending enrollment cancellation and redacted local diagnostics")
  const email = "tester@example.com"
  for (let i = 0; i < 2; i++) {
    const enrollment = await eventually(async () => { const response = await local(i, "enroll"); return response.ok ? response.json() : null }, value => Boolean(value?.id))
    console.log(`Computer ${i + 1}: enrollment created`)
    // Separate synthetic accounts exercise ownership without weakening the
    // production resend budget. Browser QA covers two hosts for one account.
    const parent = await login(i ? "second@example.com" : email, { purpose: "enroll", id: enrollment.id })
    console.log(`Computer ${i + 1}: email verified`)
    let lastState = ""
    const status = await eventually<ConnectLocalStatus>(async () => {
      const current = await (await local(i)).json() as ConnectLocalStatus
      const safe = `${current.state}:${current.error ?? ""}`
      if (safe !== lastState) { console.log(`Computer ${i + 1}: ${safe}`); lastState = safe }
      return current
    }, value => value.state === "online")
    bound.push(status)
    // This fixture first creates independent accounts, then tests ownership
    // isolation. The same-owner multiple-host flow is covered in browser QA and
    // service.test.ts without shortening production mail limits.
    hostCookies.push(await enter(i, parent))
  }
  checks.push("fresh-OTP enrollment and two independent outbound connectors")
  for (let i = 0; i < 2; i++) {
    const status = await (await host(i, "/auth/status")).json()
    assert.equal(status.authenticated, true); assert.equal(status.host.id, bound[i]!.hostId)
    assert.equal((await host(i, "/api/connect-local/unbind", { method: "POST" })).status, 403)
    assert.equal((await host(i, "/api/connect-local/diagnostics")).status, 403)
    assert.equal((await host(i, "/_stillon/update/pause", { method: "POST" })).status, 403)
    assert.equal((await host(i, "/api/browser-proxy/80/")).status, 403)
  }
  assert.equal((await host(0, "/health", { headers: { Origin: bound[1]!.url! } })).status, 403)
  assert.equal((await host(0, "/api/test", { headers: { Cookie: hostCookies[1]! } })).status, 401)
  checks.push("owner, origin, local controls and private-network preview isolation")
  const avatarRoute = "/api/appearance/avatars"
  const avatarConfigs = await Promise.all(fixture.hosts.map(async server =>
    avatarConfig(await fetch(`http://127.0.0.1:${server.port}${avatarRoute}`))))
  for (let i = 0; i < 2; i++) {
    const workspaceId = fixture.hosts[i]!.store.listProjects()[0]!.id
    const other = 1 - i
    const localOrigin = `http://127.0.0.1:${fixture.hosts[i]!.port}`
    const endpoint = localOrigin + avatarRoute
    assert.deepEqual(await avatarConfig(await host(i, avatarRoute)), avatarConfigs[i])
    const localChoice = { shape: "pebble", color: "#3d7ff5" }
    const localSaved = await avatarConfig(await fetch(endpoint, {
      method: "POST", headers: { Origin: localOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, ...localChoice }),
    }))
    assert.deepEqual(localSaved, { ...avatarConfigs[i]!, workspaces: { ...avatarConfigs[i]!.workspaces, [workspaceId]: localChoice } })
    avatarConfigs[i] = localSaved
    assert.deepEqual(await avatarConfig(await host(i, avatarRoute)), localSaved)

    const remoteChoice = { shape: "drop", color: "#4db6a3" }
    const body = JSON.stringify({ workspaceId, ...remoteChoice })
    const remoteSaved = await avatarConfig(await host(i, avatarRoute, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }))
    assert.deepEqual(remoteSaved, { ...localSaved, workspaces: { ...localSaved.workspaces, [workspaceId]: remoteChoice } })
    avatarConfigs[i] = remoteSaved
    assert.deepEqual(await avatarConfig(await fetch(endpoint)), remoteSaved)

    // A rejected request must not change either entry's view or the saved file.
    const attempts: { headers?: Record<string, string>; body?: string; status: number }[] = [
      { headers: { Cookie: "" }, status: 401 },
      { headers: { Cookie: hostCookies[other]! }, status: 401 },
      { headers: { Origin: bound[other]!.url! }, status: 403 },
      { body: JSON.stringify({ workspaceId: "unknown", shape: "round", color: "#112233" }), status: 404 },
      { body: JSON.stringify({ workspaceId, shape: "unknown", color: "#112233" }), status: 400 },
    ]
    for (const attempt of attempts) {
      const denied = await host(i, avatarRoute, {
        method: "POST", headers: { "Content-Type": "application/json", ...attempt.headers },
        body: attempt.body ?? JSON.stringify({ workspaceId, shape: "round", color: "#112233" }),
      })
      assert.equal(denied.status, attempt.status)
      await denied.arrayBuffer()
    }
    assert.deepEqual(await avatarConfig(await fetch(endpoint)), remoteSaved)
    assert.deepEqual(await avatarConfig(await host(i, avatarRoute)), remoteSaved)
    const persisted = JSON.parse(await readFile(path.join(fixture.root, `computer-${i + 1}`, "customizations/appearance/avatars.json"), "utf8"))
    assert.deepEqual(workspaceAvatarsSchema.parse(persisted), remoteSaved)
    assert.deepEqual(await avatarConfig(await host(other, avatarRoute)), avatarConfigs[other])
  }
  checks.push("avatar saves through local and full Connect entries, cross-entry reloads, disk persistence and rejected-write/account isolation")
  const ws1 = await socket(0), ws2 = await socket(1)
  for (let i = 0; i < 2; i++) {
    const localOrigin = `http://127.0.0.1:${fixture.hosts[i]!.port}`
    const localSocket = upstreamWebSocket(`${localOrigin.replace("http", "ws")}/ws`, new Headers({ Origin: localOrigin }))
    sockets.push(localSocket)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local WebSocket timed out")), 10_000)
      localSocket.addEventListener("open", () => { clearTimeout(timeout); resolve() }, { once: true })
      localSocket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Local WebSocket failed")) }, { once: true })
    })
    const remoteSocket = i ? ws2 : ws1
    const workspaceId = fixture.hosts[i]!.store.listProjects()[0]!.id
    const extraPath = path.join(fixture.root, `fold-workspace-${i}`)
    await mkdir(extraPath, { recursive: true })
    const extra = await fixture.hosts[i]!.store.openProject(extraPath, "Other workspace")
    const readFolds = async (ws: WebSocket) => {
      const reply = await command(ws, { type: "settings.readAppSettings" })
      assert.equal(reply.type, "ack")
      return reply.result.workspaceCollapsed
    }
    const otherSocket = i ? ws1 : ws2
    const otherFolds = await readFolds(otherSocket)
    assert.equal((await command(localSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [workspaceId]: true, [extra.id]: false } } })).type, "ack")
    assert.deepEqual(await readFolds(remoteSocket), { [workspaceId]: true, [extra.id]: false })
    assert.equal((await command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [workspaceId]: false } } })).type, "ack")
    assert.deepEqual(await readFolds(localSocket), { [workspaceId]: false, [extra.id]: false })
    const concurrent = await Promise.all([
      command(localSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [workspaceId]: true } } }),
      command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [extra.id]: true } } }),
    ])
    assert.ok(concurrent.every(reply => reply.type === "ack"))
    const expectedFolds = { [workspaceId]: true, [extra.id]: true }
    assert.deepEqual(await readFolds(localSocket), expectedFolds)
    assert.deepEqual(await readFolds(remoteSocket), expectedFolds)
    const foldSettingsPath = path.join(fixture.root, `computer-${i + 1}/settings.json`)
    const foldsBefore = await readFile(foldSettingsPath, "utf8")
    assert.deepEqual(JSON.parse(foldsBefore).workspaceCollapsed, expectedFolds)
    assert.equal((await command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [workspaceId]: false, [extra.id]: "false" } } })).type, "error")
    assert.equal(await readFile(foldSettingsPath, "utf8"), foldsBefore)
    assert.deepEqual(await readFolds(localSocket), expectedFolds)
    assert.deepEqual(await readFolds(otherSocket), otherFolds)
    const initialOtherView = await (await host(1 - i, "/api/sidebar-view")).json()
    const readView = async (remote: boolean) => {
      const response = remote ? await host(i, "/api/sidebar-view") : await fetch(`${localOrigin}/api/sidebar-view`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "no-store")
      const view = await response.json()
      assert.deepEqual(Object.keys(view).sort(), ["machineName", "sidebarCollapsed", "workspaceCollapsed"])
      return view
    }
    assert.equal((await command(localSocket, { type: "settings.writeAppSettingsPatch", patch: { sidebarCollapsed: true } })).type, "ack")
    assert.equal((await readView(true)).sidebarCollapsed, true)
    assert.equal((await command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { sidebarCollapsed: false } })).type, "ack")
    assert.equal((await readView(false)).sidebarCollapsed, false)
    assert.deepEqual((await readView(true)).workspaceCollapsed, expectedFolds)
    await Promise.all([
      command(localSocket, { type: "settings.writeAppSettingsPatch", patch: { sidebarCollapsed: true } }),
      command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { [workspaceId]: true } } }),
    ])
    assert.equal((await readView(false)).sidebarCollapsed, true)
    assert.deepEqual(await readView(false), await readView(true))
    const viewBefore = await readFile(foldSettingsPath, "utf8")
    assert.equal(JSON.parse(viewBefore).sidebarCollapsed, true)
    assert.equal((await command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { sidebarCollapsed: "false", workspaceCollapsed: { [workspaceId]: false } } })).type, "error")
    assert.equal(await readFile(foldSettingsPath, "utf8"), viewBefore)
    assert.deepEqual(await (await host(1 - i, "/api/sidebar-view")).json(), initialOtherView)
    const rejectedViewHeaders: Record<string, string>[] = [{ Cookie: hostCookies[1 - i]! }, { Cookie: "" }, { Origin: bound[1 - i]!.url! }]
    for (const headers of rejectedViewHeaders) {
      const denied = await host(i, "/api/sidebar-view", { headers })
      assert.equal(denied.status, "Origin" in headers ? 403 : 401)
      await denied.arrayBuffer()
    }
    const deniedFoldEntry = await host(i, "/ws", { headers: { Cookie: hostCookies[1 - i]! } })
    assert.equal(deniedFoldEntry.status, 401)
    await deniedFoldEntry.arrayBuffer()
    const exportRoute = "/api/appearance/skin/export"
    const originalOther = await (await host(1 - i, exportRoute)).json()
    const original = await (await host(i, exportRoute)).json()
    const background = await fetch(`${localOrigin}/api/appearance/background`, {
      method: "POST", headers: { Origin: localOrigin }, body: APPEARANCE_FIXTURE_PNG,
    })
    assert.equal(background.status, 200)
    const { asset } = await background.json()
    assert.equal((await (await host(i, exportRoute)).json()).background, original.background)
    const localSaved = await command(localSocket, { type: "settings.writeAppSettingsPatch", patch: { appearance: { backgroundAsset: asset, palette: "forest" } } })
    assert.equal(localSaved.type, "ack")
    const remotelyRead = await (await host(i, exportRoute)).json()
    assert.equal(remotelyRead.background.base64, APPEARANCE_FIXTURE_PNG.toString("base64"))
    assert.equal(remotelyRead.appearance.palette, "forest")
    const localAsset = await host(i, `/api/appearance/assets/${asset}`)
    assert.equal(localAsset.status, 200)
    assert.deepEqual(Buffer.from(await localAsset.arrayBuffer()), APPEARANCE_FIXTURE_PNG)

    // Exercise both uploads through the real login gateway, tunnel and adapter.
    const remoteUpload = await host(i, "/api/appearance/background", { method: "POST", body: APPEARANCE_FIXTURE_PNG })
    assert.equal(remoteUpload.status, 200)
    assert.equal((await remoteUpload.json()).asset, asset)
    const skin = { format: "stillon-skin", themeApi: 1, uiApi: 1, name: `Computer ${i + 1} skin`, appearance: { palette: "ocean", backgroundOpacity: 0.2 },
      background: { mimeType: "image/png", base64: APPEARANCE_FIXTURE_PNG.toString("base64") } }
    const imported = await host(i, "/api/appearance/skins/import", { method: "POST", body: JSON.stringify(skin), headers: { "Content-Type": "application/json" } })
    assert.equal(imported.status, 200)
    const staged = await imported.json()
    // Staging must not apply the skin until the explicit settings command.
    assert.deepEqual(await (await host(i, exportRoute)).json(), remotelyRead)
    const remoteSaved = await command(remoteSocket, { type: "settings.writeAppSettingsPatch", patch: { appearance: staged.appearance } })
    assert.equal(remoteSaved.type, "ack")
    const applied = await (await fetch(localOrigin + exportRoute)).json()
    assert.equal(applied.name, skin.name)
    assert.equal(applied.appearance.palette, "ocean")
    assert.equal(applied.background.base64, skin.background.base64)
    assert.deepEqual(await (await host(i, exportRoute)).json(), applied)
    const settingsPath = path.join(fixture.root, `computer-${i + 1}/settings.json`)
    const diskBefore = await readFile(settingsPath, "utf8")
    assert.deepEqual(JSON.parse(diskBefore).appearance, staged.appearance)
    const appearanceDir = path.join(fixture.root, `computer-${i + 1}/customizations/appearance`)
    const filesBefore = (await readdir(appearanceDir, { recursive: true })).sort()
    for (const route of ["/api/appearance/background", "/api/appearance/skins/import"]) {
      const validBody = route.endsWith("background") ? APPEARANCE_FIXTURE_PNG : JSON.stringify(skin)
      for (const [headers, status] of [
        [{ Cookie: "" }, 401], [{ Cookie: hostCookies[1 - i]! }, 401], [{ Origin: bound[1 - i]!.url! }, 403],
      ] as const) {
        const denied = await host(i, route, { method: "POST", body: validBody, headers })
        assert.equal(denied.status, status)
        await denied.arrayBuffer()
      }
      const invalid = await host(i, route, { method: "POST", body: "invalid" })
      assert.equal(invalid.status, 400)
      assert.equal(typeof (await invalid.json()).error, "string")
    }
    assert.equal(await readFile(settingsPath, "utf8"), diskBefore)
    assert.deepEqual((await readdir(appearanceDir, { recursive: true })).sort(), filesBefore)
    assert.deepEqual(await (await fetch(localOrigin + exportRoute)).json(), applied)
    assert.deepEqual(await (await host(i, exportRoute)).json(), applied)
    assert.deepEqual(await (await host(1 - i, exportRoute)).json(), originalOther)
    localSocket.close()
  }
  checks.push("Workspace fold persistence across local/Connect, concurrent per-Workspace writes, explicit false, rejected patches and account/host isolation")
  checks.push("authenticated first-render sidebar view, whole-sidebar local/Connect persistence, cross-entry bootstrap reads and atomic invalid-write rejection")
  checks.push("background and skin local/Connect uploads, explicit cross-entry apply/reload, disk persistence and rejected-write/account/host isolation")
  const project = fixture.hosts[0]!.store.listProjects()[0]!
  const operationId = `${Date.now()}-${crypto.randomUUID()}`
  const created = await command(ws1, { type: "chat.create", projectId: project.id }, operationId)
  assert.equal(created.type, "ack")
  const repeated = await command(ws1, { type: "chat.create", projectId: project.id }, operationId)
  assert.equal(repeated.result.chatId, created.result.chatId)
  assert.equal((await command(ws1, { type: "settings.requestManagedUpdate" })).type, "error")
  assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  checks.push("real StillOn WebSocket commands and durable duplicate suppression")
  for (const mib of [1, 20, 100]) {
    const payload = randomBytes(mib * 1024 * 1024)
    const expected = createHash("sha256").update(payload).digest("hex")
    const started = performance.now()
    console.log(`Checking ${mib} MiB upload/download`)
    const form = new FormData(); form.append("files", new File([payload], `test-${mib}.bin`))
    const upload = await host(0, `/api/projects/${project.id}/uploads`, { method: "POST", body: form })
    if (!upload.ok) throw new Error(`Upload failed: ${upload.status} ${await upload.text()}`)
    const attachment = (await upload.json()).attachments[0]
    const download = await host(0, attachment.contentUrl)
    assert.equal(download.status, 200)
    const actual = createHash("sha256")
    let chunks = 0
    for await (const chunk of download.body!) {
      actual.update(chunk)
      // Exercise a slower reader while the other computer keeps responding.
      if (mib === 100 && ++chunks % 16 === 0) {
        assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
        await Bun.sleep(5)
      }
    }
    assert.equal(actual.digest("hex"), expected)
    const range = await host(0, attachment.contentUrl, { headers: { Range: "bytes=123-1146" } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get("content-range"), `bytes 123-1146/${payload.length}`)
    assert.deepEqual(await range.bytes(), payload.subarray(123, 1147))
    console.log(`${mib} MiB verified in ${Math.round(performance.now() - started)} ms`)
  }
  const tooLarge = new FormData(); tooLarge.append("files", new File([new Uint8Array(101 * 1024 * 1024)], "too-large.bin"))
  const rejected = await host(0, `/api/projects/${project.id}/uploads`, { method: "POST", body: tooLarge })
  assert.equal(rejected.status, 413); await rejected.arrayBuffer()
  const chineseName = "商务分析 报告.txt"
  await writeFile(path.join(project.localPath, chineseName), "业务数据留在同一台电脑")
  const fileRoute = `/api/projects/${project.id}/files/${encodeURIComponent(chineseName)}/content?download=1`
  const head = await host(0, fileRoute, { method: "HEAD" })
  assert.equal(head.status, 200); assert.equal((await head.bytes()).length, 0)
  assert.ok(head.headers.get("content-disposition")!.includes(encodeURIComponent(chineseName)))
  assert.equal(await (await host(0, fileRoute)).text(), "业务数据留在同一台电脑")
  checks.push("1/20/100 MiB SHA256, slow reader with second-host pings, Range, Chinese filenames, HEAD and 101 MiB rejection")
  const preview = await host(0, `/api/projects/${project.id}/preview/report.html`)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get("content-security-policy")!, /sandbox/)
  assert.doesNotMatch(preview.headers.get("content-security-policy")!, /allow-same-origin/)
  for (let i = 0; i < 40; i++) { const response = await host(0, "/health"); assert.equal(response.status, 200); await response.arrayBuffer() }
  checks.push("active-file sandbox headers and completed-request lease cleanup")
  const identityFile = path.join(fixture.root, "computer-1/connect/device.json")
  const raw = await readFile(identityFile, "utf8")
  assert.ok(raw.includes("privateKey"))
  assert.ok(!JSON.stringify(await (await local(0)).json()).includes("privateKey"))
  if (process.platform !== "win32") assert.equal((await stat(identityFile)).mode & 0o777, 0o600)
  checks.push("device identity stays local with owner-only file permissions")
  console.log("Checking renewal across the original 45 s lease boundary")
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(13_000)
    assert.equal((await command(ws1, { type: "system.ping" })).type, "ack")
    assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  }
  checks.push("both active WebSocket leases renew across 52 s without reconnecting")
  const logout = await host(0, "/auth/logout", { method: "POST" })
  assert.equal(logout.status, 200)
  await eventually(async () => ws1.readyState, value => value === WebSocket.CLOSED, 5_000)
  assert.equal((await host(0, "/api/test")).status, 401)
  assert.equal((await command(ws2, { type: "system.ping" })).type, "ack")
  assert.ok(fixture.hosts[0]!.store.getChat(created.result.chatId))
  assert.equal((await (await local(0)).json()).state, "online")
  checks.push("Logout closes remote streams while preserving binding and local task state")
  assert.ok((await eventually(async () => local(1, "pause"), response => response.ok)).ok)
  await eventually(async () => ws2.readyState, value => value === WebSocket.CLOSED, 5_000)
  const offline = await host(1, "/", { headers: { Accept: "text/html" } })
  assert.equal(offline.status, 503); assert.ok((await offline.text()).includes("Logout"))
  assert.ok((await eventually(async () => local(1, "resume"), response => response.ok)).ok)
  await eventually<ConnectLocalStatus>(async () => (await local(1)).json(), value => value.state === "online")
  assert.ok((await eventually(async () => local(1, "unbind"), response => response.ok)).ok)
  await eventually<ConnectLocalStatus>(async () => (await local(1)).json(), value => value.state === "unbound")
  assert.equal((await host(1, "/api/test")).status, 401)
  assert.ok(fixture.hosts[1]!.store.listProjects().length)
  checks.push("pause, resume, offline page and unbind preserve workspace data")
  console.log(JSON.stringify({ passed: true, platform: process.platform, architecture: process.arch, checks }, null, 2))
} catch (error) { console.error("Integration check failed:", error); throw error }
finally { for (const ws of sockets) ws.close(); await fixture.stop() }
