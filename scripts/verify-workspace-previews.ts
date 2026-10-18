import assert from "node:assert/strict"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createConnectFixture, eventually } from "./connect-fixture"
import { startStillOnServer } from "../src/server/server"

// Synthetic accounts/files only. Never enrolls a production computer, sends
// mail, starts an Agent, or changes the installed application's environment.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
process.env.STILLON_MACHINE_NAME = "Preview test computer"
const localOnly = process.argv.includes("--local-only")
const browserOutput = process.argv.find(value => value.startsWith("--browser-output="))?.slice(17)
const stopFile = process.argv.find(value => value.startsWith("--stop-file="))?.slice(12)
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-workspace-previews-"))
const output = path.resolve("test-artifacts/workspace-previews")
await mkdir(output, { recursive: true })
const connect = localOnly ? undefined : await createConnectFixture(2)
const server = connect?.hosts[0] ?? await startStillOnServer({ port: 0, dataDir: path.join(root, "data"), discoveryHome: root })
const servers: ReturnType<typeof Bun.serve>[] = []
const checks: { entry: string; check: string; result: string }[] = []
let stage = "setup"
const localOrigin = `http://127.0.0.1:${server.port}`
interface Entry { name: string; origin: string; cookie?: string; gateway?: string }
const entries: Entry[] = [{ name: "loopback", origin: localOrigin }]
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
async function request(entry: Entry, route: string, body?: object, method = body ? "POST" : "GET") {
  const target = new URL(route, entry.origin)
  const response = await fetch(entry.gateway ? entry.gateway + target.pathname + target.search : target.href, {
    method, redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Origin: entry.origin, Host: target.host,
      "Content-Type": "application/json", Cookie: entry.cookie ?? "" }, body: body ? JSON.stringify(body) : undefined,
  })
  return response
}
async function json(entry: Entry, route: string, body?: object) {
  for (let attempt = 0; ; attempt++) {
    // Like the UI's polling, retry only a transient frame read. The input may
    // already have been applied; never replay a click, form or other POST.
    const response = await request(entry, route, attempt === 0 ? body : undefined)
    const value = await response.json() as any
    if (response.status === 503 && value.retryableFrame === true && /^\/api\/preview-browser\/[\w-]+$/u.test(route) && attempt < 3) {
      await Bun.sleep(200); continue
    }
    assert.ok(response.ok, `${entry.name} ${route}: ${JSON.stringify(value)}`)
    return value
  }
}
async function fixtureFiles(directory: string) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Loading fixture</title><link rel="stylesheet" href="./style.css"><h1>Workspace preview</h1><p id="module">Loading module</p><button id="add">Add one</button><a id="next" href="./next.html?tab=one#section">Next page</a><img src="./中文 image.png" alt="Fixture pixel"><script src="./classic.js"></script><script type="module" src="./中文 module.js"></script></html>`)
  await writeFile(path.join(directory, "classic.js"), "window.classicReady=true")
  await writeFile(path.join(directory, "中文 module.js"), `const data=await(await fetch('./data.json')).json();let count=Number(localStorage.count||0);function render(){document.title='Fixture '+count+' '+data.label+' '+window.classicReady;document.querySelector('#module').textContent='ES module ready';document.querySelector('#add').textContent='Add one: '+count}render();document.querySelector('#add').onclick=()=>{localStorage.count=++count;render()};`)
  await writeFile(path.join(directory, "next.html"), '<!doctype html><title>Nested fixture</title><h1 id="section">Next page</h1><a href="./index.html">Return</a>')
  await writeFile(path.join(directory, "data.json"), '{"label":"static-fetch"}')
  await writeFile(path.join(directory, "style.css"), '@font-face{font-family:Fixture;src:url("./fixture.woff2")}body{font:18px Fixture,system-ui;margin:24px;background:#f1f8f5;color:#173b32}button{position:absolute;top:120px;left:24px;width:160px;height:44px;font:inherit}#next{position:absolute;top:180px;left:24px}img{width:20px;height:20px}')
  await writeFile(path.join(directory, "中文 image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwH0AAAAASUVORK5CYII=", "base64"))
  const fonts = path.resolve("node_modules/@fontsource-variable/bricolage-grotesque/files")
  const font = (await readdir(fonts)).find(name => name.endsWith(".woff2"))!
  await copyFile(path.join(fonts, font), path.join(directory, "fixture.woff2"))
  await writeFile(path.join(directory, "README.md"), '# Preview guide\n\n![Fixture image](中文%20image.png)\n\n| Item | Status |\n|---|---|\n| Markdown | Ready |\n\n```js\nconst preview = true\n```\n\n[Next document](next.md?tab=one#next-section) · [HTML application](index.html) · [Section](#details)\n\n## Details\n\nA complete rendered document.\n')
  await writeFile(path.join(directory, "next.md"), '# Next section\n\n[Return](README.md)\n')
}
try {
  if (connect) {
    const enroll = await eventually(async () => {
      const response = await request(entries[0]!, "/api/connect-local/enroll", {})
      return response.ok ? response.json() : null
    }, value => Boolean(value?.id))
    const intent = { purpose: "enroll", id: enroll.id }, email = "preview@example.com"
    const central = (route: string, body: object, cookie = "") => fetch(connect.origin + "/api/connect/" + route, {
      method: "POST", headers: { Origin: connect.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body), redirect: "manual" })
    const pending = await central("request-code", { email, intent })
    const verified = await central("verify-code", { email, intent, code: connect.messages.at(-1)!.code, remember: true }, cookies(pending))
    assert.equal(verified.status, 200)
    const status = await eventually(async () => (await request(entries[0]!, "/api/connect-local/status")).json(), value => value.state === "online")
    const remote: Entry = { name: "connect-integration", origin: new URL(status.url!).origin, gateway: connect.origin }
    const login = await request(remote, "/_connect/login")
    const flow = new URL(login.headers.get("location")!).searchParams.get("flow")
    const authorized = await central("authorize", { flow }, cookies(verified))
    const callback = (await authorized.json()).redirect
    remote.cookie = cookies(login)
    const entered = await request(remote, new URL(callback).pathname + new URL(callback).search)
    assert.equal(entered.status, 303); remote.cookie = cookies(entered); entries.push(remote)
  }
  const projectPath = path.join(root, "workspace")
  const outsidePath = path.join(root, "outside")
  await fixtureFiles(projectPath); await fixtureFiles(outsidePath)
  const project = await server.store.openProject(projectPath, "Preview workspace")
  const chat = await server.store.createChat(project.id)
  let count = 0
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, appServer) {
      const url = new URL(request.url)
      if (url.pathname === "/socket" && appServer.upgrade(request)) return
      if (url.pathname === "/api/counter") {
        if (request.method === "POST") count++
        return Response.json({ count, cookie: request.headers.get("cookie") ?? "", authorization: request.headers.get("authorization") ?? "",
          control: [...request.headers.keys()].filter(name => name.startsWith("x-stillon-")) })
      }
      if (url.pathname === "/") return new Response("Root intentionally unavailable", { status: 404 })
      return new Response(`<!doctype html><title>Application loading</title><style>body{font:18px system-ui;margin:24px}button{position:absolute;left:24px;top:100px;width:160px;height:44px;font:inherit}a{position:absolute;left:24px;top:170px}</style><h1>Dynamic application</h1><button id="add">Add one</button><a href="/nested?tab=one#section">Nested route</a><form action="/api/counter" method="post" style="position:absolute;left:24px;top:240px"><input name="sample" value="example" style="width:160px"><input type="submit" value="Save form" style="width:140px;height:44px"></form><script>
      let wsReady=false;const ws=new WebSocket('ws://'+location.host+'/socket');ws.onopen=()=>ws.send('echo');ws.onmessage=()=>{wsReady=true;render()};
      async function render(){const value=await(await fetch('/api/counter')).json();document.title='Application '+value.count+' '+wsReady;document.querySelector('#add').textContent='Add one: '+value.count}document.querySelector('#add').onclick=async()=>{await fetch('/api/counter',{method:'POST'});localStorage.saved='yes';await render()};render();</script>`, { headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } })
    }, websocket: { message(ws, message) { ws.send(message) } },
  })
  servers.push(app)
  const appOrigin = `http://127.0.0.1:${app.port}`
  await server.store.appendMessage(chat.id, { kind: "assistant_text", _id: "preview-fixture-links", createdAt: Date.now(),
    text: `[Read guide](<${path.join(projectPath, "README.md").replaceAll("\\", "/")}>) · [HTML sample](<${path.join(projectPath, "index.html").replaceAll("\\", "/")}>) · [HTTP application](${appOrigin}/app?tab=one#section)` })
  const addresses: Record<string, Record<string, string>> = {}
  const targetIds: Record<string, Record<string, string>> = {}
  for (const entry of entries) {
    const outside = await json(entry, "/api/local-html-previews", { filePath: path.join(outsidePath, "index.html") })
    addresses[entry.name] = { "project-markdown": `/api/projects/${project.id}/markdown-preview/README.md`,
      "outside-markdown": `/api/local-files/markdown-preview/${encodeURIComponent(path.join(outsidePath, "README.md"))}`,
      "project-html": `/api/projects/${project.id}/preview/index.html`, "outside-html": outside.url,
      dynamic: appOrigin + "/app?tab=one#section" }
    targetIds[entry.name] = {}
    for (const [name, address] of Object.entries(addresses[entry.name]!)) {
      stage = entry.name + ":" + name
      const target = await json(entry, "/api/preview-targets", { projectId: project.id, address })
      targetIds[entry.name]![name] = target.id
      if (name.endsWith("markdown")) {
        const content = name === "project-markdown" ? `/api/projects/${project.id}/files/README.md/content` : `/api/local-files/content/${encodeURIComponent(path.join(outsidePath, "README.md"))}`
        const response = await request(entry, content); assert.equal(response.status, 200); assert.match(await response.text(), /Preview guide/)
        checks.push({ entry: entry.name, check: name + " authenticated target and content", result: "Pass" }); continue
      }
      const session = await json(entry, "/api/preview-browser", { targetId: target.id })
      assert.equal((await request(entry, "/api/preview-browser/" + session.id, { type: "key", key: "Control+V" })).status, 400)
      stage = entry.name + ":" + name + ":initial-readiness"
      let frame = await eventually(() => json(entry, "/api/preview-browser/" + session.id), value => { if (name === "dynamic") console.log("Dynamic readiness", value.title, value.error ?? ""); return name === "dynamic" ? /Application \d+ true/u.test(value.title) : value.title === "Fixture 0 static-fetch true" })
      assert.ok(frame.image.length > 1000)
      frame = await json(entry, "/api/preview-browser/" + session.id, { type: "click", x: 60, y: name === "dynamic" ? 120 : 140 })
      stage = entry.name + ":" + name + ":button"
      frame = await eventually(() => json(entry, "/api/preview-browser/" + session.id), value => name === "dynamic" ? /Application [1-9]\d* true/u.test(value.title) : value.title === "Fixture 1 static-fetch true")
      const reopened = await json(entry, "/api/preview-browser", { targetId: target.id })
      assert.equal(reopened.id, session.id, "Sidebar/standalone reuse the same authenticated browser session")
      await json(entry, "/api/preview-browser/" + session.id, { type: "reload" })
      stage = entry.name + ":" + name + ":reload"
      const refreshed = await eventually(() => json(entry, "/api/preview-browser/" + session.id), value => name === "dynamic" ? /Application \d+ true/u.test(value.title) : value.title === "Fixture 1 static-fetch true")
      assert.equal(refreshed.error, undefined)
      if (name !== "dynamic") assert.equal(refreshed.title, "Fixture 1 static-fetch true", "Storage survives reload")
      await writeFile(path.join(output, entry.name + "-" + name + ".jpg"), Buffer.from(frame.image, "base64"))
      if (name === "dynamic") {
        const value = await (await fetch(appOrigin + "/api/counter")).json()
        assert.equal(value.count, count); assert.equal(value.cookie, ""); assert.equal(value.authorization, ""); assert.deepEqual(value.control, [])
        await fetch(appOrigin + "/api/counter", { method: "POST" })
        await json(entry, "/api/preview-browser/" + session.id, { type: "reload" })
        stage = entry.name + ":dynamic:backend-update"
        frame = await eventually(() => json(entry, "/api/preview-browser/" + session.id), value => new RegExp("Application " + count + " ").test(value.title))
        assert.match(frame.title, new RegExp("Application " + count + " "))
        frame = await json(entry, "/api/preview-browser/" + session.id, { type: "navigate", address: appOrigin + "/nested?tab=two#detail" })
        assert.equal(frame.address, appOrigin + "/nested?tab=two#detail")
        await writeFile(path.join(output, entry.name + "-before-form.jpg"), Buffer.from(frame.image, "base64"))
        const beforeForm = count
        await json(entry, "/api/preview-browser/" + session.id, { type: "click", x: 240, y: 260 })
        stage = entry.name + ":dynamic:form-submit"
        await eventually(async () => count, value => value === beforeForm + 1)
        assert.equal(count, beforeForm + 1, "A native HTML form submits exactly once")
        await json(entry, "/api/preview-browser/" + session.id, { type: "reload" })
        assert.equal(count, beforeForm + 1, "Refresh must not replay a POST form")
      }
      checks.push({ entry: entry.name, check: name + " resources, input, storage, reload" + (name === "dynamic" ? ", API, WebSocket, bidirectional writes, deep navigation" : ""), result: "Pass" })
      await request(entry, "/api/preview-browser/" + session.id, undefined, "DELETE")
    }
    const protectedTarget = await json(entry, "/api/preview-targets", { address: localOrigin, projectId: project.id })
    const protectedResponse = await request(entry, "/api/preview-browser", { targetId: protectedTarget.id })
    assert.equal(protectedResponse.status, 503, "Control application cannot be reached by the preview browser")
    checks.push({ entry: entry.name, check: "StillOn control port denied", result: "Pass" })
    for (const variant of ["no-title", "root-404", "slow-root", "application-401", "application-403", "application-500"]) {
      stage = entry.name + ":" + variant
      const variantServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/" && variant === "slow-root") await Bun.sleep(900)
        if (url.pathname === "/" && variant === "root-404") return new Response("Not found", { status: 404 })
        return new Response("<!doctype html><h1>Explicit application path</h1><script>document.title='Variant ready'</script>", { status: variant.startsWith("application-") ? Number(variant.slice(12)) : 200, headers: { "Content-Type": "text/html" } })
      } })
      servers.push(variantServer)
      const address = `http://localhost:${variantServer.port}/app?variant=${variant}#section`
      const target = await json(entry, "/api/preview-targets", { projectId: project.id, address })
      const session = await json(entry, "/api/preview-browser", { targetId: target.id })
      const frame = await json(entry, "/api/preview-browser/" + session.id)
      assert.equal(frame.title, "Variant ready"); assert.equal(frame.address, address)
      await request(entry, "/api/preview-browser/" + session.id, undefined, "DELETE")
      checks.push({ entry: entry.name, check: "Explicit path admission: " + variant, result: "Pass" })
    }
    if (process.argv.includes("--external-sites")) {
      for (const [name, address] of Object.entries({ "external-https": "https://example.com/", "external-frame-policy": "https://github.com/", "external-http": "http://example.com/" })) {
        stage = entry.name + ":" + name
        addresses[entry.name]![name] = address
        const target = await json(entry, "/api/preview-targets", { projectId: project.id, address })
        targetIds[entry.name]![name] = target.id
        const session = await json(entry, "/api/preview-browser", { targetId: target.id })
        try {
          const frame = await eventually(() => json(entry, "/api/preview-browser/" + session.id), value => Boolean(value.title) && !value.error)
          assert.ok(frame.image.length > 1000)
          checks.push({ entry: entry.name, check: name + " public website rendered by the isolated browser", result: "Pass" })
        } catch {
          delete addresses[entry.name]![name]
          checks.push({ entry: entry.name, check: name + " public website network smoke", result: "Blocked: website or network unavailable" })
        } finally { await request(entry, "/api/preview-browser/" + session.id, undefined, "DELETE") }
      }
    }
    stage = entry.name + ":service-recovery"
    const stopped = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
    const restartPort = stopped.port!
    await stopped.stop(true)
    const recoveryAddress = `http://127.0.0.1:${restartPort}/app?recover=one#section`
    const recoveryTarget = await json(entry, "/api/preview-targets", { projectId: project.id, address: recoveryAddress })
    const recoverySession = await json(entry, "/api/preview-browser", { targetId: recoveryTarget.id })
    const unavailable = await json(entry, "/api/preview-browser/" + recoverySession.id)
    assert.ok(unavailable.error)
    const restored = Bun.serve({ hostname: "127.0.0.1", port: restartPort, fetch: () => new Response('<!doctype html><title>Service restored</title><h1>Ready</h1>', { headers: { "Content-Type": "text/html" } }) })
    servers.push(restored)
    await json(entry, "/api/preview-browser/" + recoverySession.id, { type: "reload" })
    const recovered = await eventually(() => json(entry, "/api/preview-browser/" + recoverySession.id), value => value.title === "Service restored" && !value.error)
    assert.equal(recovered.address, recoveryAddress)
    await writeFile(path.join(output, entry.name + "-recovery-unavailable.jpg"), Buffer.from(unavailable.image, "base64"))
    await writeFile(path.join(output, entry.name + "-recovery-restored.jpg"), Buffer.from(recovered.image, "base64"))
    await request(entry, "/api/preview-browser/" + recoverySession.id, undefined, "DELETE")
    checks.push({ entry: entry.name, check: "Stopped service recovers immediately at the same deep target without a negative cache", result: "Pass" })
  }
  if (entries[1]) {
    const stolen = await request(entries[0]!, "/api/preview-targets/" + targetIds[entries[1].name]!["project-html"])
    assert.equal(stolen.status, 410)
    checks.push({ entry: "cross-entry", check: "Opaque target ID does not grant another owner access", result: "Pass" })
  }
  await writeFile(path.join(output, "api-results.json"), JSON.stringify({ localOnly, checks }, null, 2))
  console.log(JSON.stringify({ localOnly, checks }, null, 2))
  if (browserOutput) {
    await writeFile(path.resolve(browserOutput), JSON.stringify({ entries, addresses, targetIds, projectId: project.id, chatId: chat.id, appOrigin, output, gatewayVersion: "source fixture", sourceVersion: "0.6.2" }))
    console.log("Workspace browser fixture ready")
    if (stopFile) { while (true) { try { await readFile(stopFile); break } catch { await Bun.sleep(200) } } }
    else await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
  }
} catch (error) {
  console.error("Preview fixture failed at " + stage)
  throw error
} finally {
  for (const app of servers) await app.stop(true)
  if (connect) await connect.stop(); else await server.stop()
  // Only the explicitly generated temporary fixture root is removed.
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("stillon-workspace-previews-")) await rm(root, { recursive: true, force: true })
}
