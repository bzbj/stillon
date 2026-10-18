import { previewImageBytes, longImagePng } from "./preview-image-fixtures"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { previewInputHtml } from "./preview-input-fixture"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createConnectFixture, eventually } from "./connect-fixture"
import { startStillOnServer } from "../src/server/server"
import { PreviewBrowser } from "../src/server/preview-browser"
import { listLocalHttpServers } from "../src/server/local-http-servers"
import { ConnectRelay } from "../src/server/connect/relay"

// Synthetic accounts/files only. Never enrolls a production computer, sends
// mail, starts an Agent, or changes the installed application's environment.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
process.env.STILLON_MACHINE_NAME = "Preview test computer"
const localOnly = process.argv.includes("--local-only")
const filesOnly = process.argv.includes("--files-only")
const browserOutput = process.argv.find(value => value.startsWith("--browser-output="))?.slice(17)
const stopFile = process.argv.find(value => value.startsWith("--stop-file="))?.slice(12)
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-workspace-previews-"))
if (filesOnly) process.env.STILLON_PREVIEW_BROWSER = path.join(root, "browser-intentionally-unavailable")
const output = browserOutput ? path.dirname(path.resolve(browserOutput)) : path.resolve("test-artifacts/workspace-previews")
await mkdir(output, { recursive: true })
// Report only synthetic transport state on failure, never headers, tokens,
// target authorities or response bodies. Successful relay behavior is unchanged.
const relayHttp = ConnectRelay.prototype.http
ConnectRelay.prototype.http = async function (...args) {
  const [request, , , scope] = args
  const diagnostic = (error?: unknown) => {
    let authorized = false
    try { authorized = scope.valid() } catch { /* Expired fixture scope. */ }
    console.warn("Preview relay diagnostic:", JSON.stringify({ hop: request.headers.has("x-stillon-connect-lease") ? "adapter" : "gateway",
      path: new URL(request.url).pathname, active: this.activeCount, authorized,
      code: error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : undefined }))
  }
  try { const response = await relayHttp.apply(this, args); if (response.status === 503) diagnostic(); return response }
  catch (error) { diagnostic(error); throw error }
}
const connect = localOnly ? undefined : await createConnectFixture(2)
const server = connect?.hosts[0] ?? await startStillOnServer({ port: 0, dataDir: path.join(root, "data"), discoveryHome: root, codexModelDiscovery: { discover: async () => { throw new Error("Disabled in preview fixture") } } })
const servers: ReturnType<typeof Bun.serve>[] = []
const sourceCommit = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { stderr: "ignore" }).stdout).trim()
const dirty = new TextDecoder().decode(Bun.spawnSync(["git", "status", "--porcelain"], { stderr: "ignore" }).stdout).trim().length > 0
const downloads: { entry: string; scope: string; name: string; size: number; sha256: string; contentType: string | null }[] = []
const checks: { entry: string; check: string; result: string }[] = []
let stage = "setup"
const progress = setInterval(() => console.log("Preview fixture stage: " + stage), 10_000)
progress.unref()
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
  await writeFile(path.join(directory, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Loading fixture</title><link rel="stylesheet" href="./style.css"><h1>Workspace preview</h1><p id="module">Loading module</p><button id="add">Add one</button><a id="next" href="./pages/next.html?tab=one#section">Next page</a><img src="./中文 image.png" alt="Fixture pixel"><input id="native-input" aria-label="File input" style="position:absolute;top:220px;left:24px;width:320px;height:40px"><div id="native-drag" style="position:absolute;top:300px;left:50px;width:100px;height:70px;background:teal;touch-action:none">Drag 0</div><script>const drag=document.querySelector("#native-drag");let start=0;drag.onpointerdown=e=>{start=e.clientX;drag.setPointerCapture(e.pointerId)};drag.onpointermove=e=>{if(drag.hasPointerCapture(e.pointerId)){drag.dataset.x=String(e.clientX-start);drag.textContent="Drag "+drag.dataset.x}};</script><canvas id="native-canvas" width="20" height="20"></canvas><script>const ctx=document.querySelector("#native-canvas").getContext("2d");ctx.fillStyle="#2896b4";ctx.fillRect(0,0,20,20);</script><script src="./classic.js"></script><script type="module" src="./中文 module.js"></script></html>`)
  await writeFile(path.join(directory, "classic.js"), "window.classicReady=true")
  await writeFile(path.join(directory, "中文 module.js"), `const data=await(await fetch('./data.json')).json();let count=Number(localStorage.count||0);function render(){document.title='Fixture '+count+' '+data.label+' '+window.classicReady;document.querySelector('#module').textContent='ES module ready';document.querySelector('#add').textContent='Add one: '+count}render();document.querySelector('#add').onclick=()=>{localStorage.count=++count;render()};`)
  await mkdir(path.join(directory, "pages"))
  await writeFile(path.join(directory, "pages", "next.html"), '<!doctype html><title>Nested fixture</title><link rel="stylesheet" href="/style.css"><h1 id="section">Next page</h1><p id="nested-resource">Loading nested resources</p><a href="/index.html">Return</a><script type="module">const data=await(await fetch("/data.json")).json();document.querySelector("#nested-resource").textContent=data.label==="static-fetch"?"Nested resources ready":"Resource failed"</script>')
  await writeFile(path.join(directory, "data.json"), '{"label":"static-fetch"}')
  await writeFile(path.join(directory, "style.css"), '@font-face{font-family:Fixture;src:url("./fixture.woff2")}body{font:18px Fixture,system-ui;margin:24px;background:#f1f8f5;color:#173b32}button{position:absolute;top:120px;left:24px;width:160px;height:44px;font:inherit}#next{position:absolute;top:180px;left:24px}img{width:20px;height:20px}')
  await writeFile(path.join(directory, "中文 image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"))
  for (const [extension, bytes] of Object.entries(previewImageBytes)) await writeFile(path.join(directory, "图 image." + extension), Buffer.from(bytes, "base64"))
  await writeFile(path.join(directory, "图 image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="teal"/><script>parent.svgExecuted=true</script></svg>')
  await writeFile(path.join(directory, "long.png"), Buffer.from(longImagePng, "base64"))
  await writeFile(path.join(directory, "large-dimensions.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="8000"><rect width="8000" height="8000" fill="teal"/></svg>')
  await writeFile(path.join(directory, "broken.png"), "not an image")
  await writeFile(path.join(directory, "oversized.png"), Buffer.alloc(25 * 1024 * 1024 + 1))
  const fonts = path.resolve("node_modules/@fontsource-variable/bricolage-grotesque/files")
  const font = (await readdir(fonts)).find(name => name.endsWith(".woff2"))!
  await copyFile(path.join(fonts, font), path.join(directory, "fixture.woff2"))
  await writeFile(path.join(directory, "README.md"), '# Preview guide\n\n![Fixture image](中文%20image.png)\n\n| Item | Status |\n|---|---|\n| Markdown | Ready |\n\n```js\nconst preview = true\n```\n\n[Next document](next.md?tab=one#next-section) · [HTML application](index.html) · [Text](中文%20text.txt) · [Image](中文%20image.png) · [Office](sample.docx) · [External](https://example.com/report.html) · [Section](#details)\n\n## Details\n\nA complete rendered document.\n')
  await writeFile(path.join(directory, "中文 text.txt"), '中文 text <script>throw new Error("must not execute")</script>\n  spaces\n')
  for (const name of ["sample.docx", "sample.pptx"]) await copyFile(path.resolve("test-fixtures/preview-files", name), path.join(directory, name))
  await writeFile(path.join(directory, "next.md"), '# Next section\n\n[Return](README.md)\n')
}
try {
  if (connect) {
    stage = "connect:request-enrollment"
    const enroll = await eventually(async () => {
      const response = await request(entries[0]!, "/api/connect-local/enroll", {})
      return response.ok ? response.json() : null
    }, value => Boolean(value?.id))
    const intent = { purpose: "enroll", id: enroll.id }, email = "preview@example.com"
    stage = "connect:verify-enrollment"
    const central = (route: string, body: object, cookie = "") => fetch(connect.origin + "/api/connect/" + route, {
      method: "POST", headers: { Origin: connect.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body), redirect: "manual" })
    const pending = await central("request-code", { email, intent })
    const verified = await central("verify-code", { email, intent, code: connect.messages.at(-1)!.code, remember: true }, cookies(pending))
    assert.equal(verified.status, 200)
    stage = "connect:wait-online"
    let lastConnectState = ""
    const status = await eventually(async () => {
      const value = await (await request(entries[0]!, "/api/connect-local/status")).json() as any
      const state = String(value.state) + ":" + String(value.error ?? "")
      if (state !== lastConnectState) { console.log("Connect fixture state", state); lastConnectState = state }
      return value
    }, value => value.state === "online")
    const remote: Entry = { name: "connect-integration", origin: new URL(status.url!).origin, gateway: connect.origin }
    stage = "connect:authenticate-workspace"
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
  for (const arguments_ of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Preview test", "-c", "user.email=preview@example.com", "commit", "--quiet", "-m", "Preview fixture"]]) {
    const git = Bun.spawn(["git", "-C", projectPath, ...arguments_], { stdout: "ignore", stderr: "ignore" })
    assert.equal(await git.exited, 0)
  }
  const project = await server.store.openProject(projectPath, "Preview workspace")
  const chat = await server.store.createChat(project.id)
  await writeFile(path.join(projectPath, "TREE-ENTRY.md"), await readFile(path.join(projectPath, "README.md")))
  await copyFile(path.join(projectPath, "中文 image.png"), path.join(projectPath, "TREE-IMAGE.png"))
  await copyFile(path.join(projectPath, "sample.docx"), path.join(projectPath, "TREE-OFFICE.docx"))
  const inputStates = new Map<string, { revision: number }>()
  let count = 0
  let activeSockets = 0
  let serviceListPort = 0
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, appServer) {
      const url = new URL(request.url)
      if (url.pathname === "/input-state") {
        const key = url.searchParams.get("case") ?? ""
        if (request.method === "POST") {
          const value = await request.json() as { revision: number }
          if (value.revision > (inputStates.get(key)?.revision ?? 0)) inputStates.set(key, value)
        }
        return Response.json(inputStates.get(key) ?? {})
      }
      if (url.pathname === "/input") return new Response(previewInputHtml, { headers: { "Content-Type": "text/html;charset=utf-8", "X-Frame-Options": "DENY" } })
      if (url.pathname === "/socket" && appServer.upgrade(request)) return
      if (url.pathname === "/api/counter") {
        if (request.method === "POST") count++
        return Response.json({ count, cookie: request.headers.get("cookie") ?? "", authorization: request.headers.get("authorization") ?? "",
          control: [...request.headers.keys()].filter(name => name.startsWith("x-stillon-")) })
      }
      if (url.pathname === "/") return new Response("Root intentionally unavailable", { status: 404 })
      return new Response(`<!doctype html><title>Application loading</title><style>body{font:18px system-ui;margin:24px}button{position:absolute;left:24px;top:100px;width:160px;height:44px;font:inherit}a{position:absolute;left:24px;top:170px}</style><h1>Dynamic application</h1><button id="add">Add one</button><a href="/nested?tab=one#section">Nested route</a><form action="/api/counter" method="post" style="position:absolute;left:24px;top:240px"><input name="sample" value="example" style="width:160px"><input type="submit" value="Save form" style="width:140px;height:44px"></form><script>
      let wsReady=false;const ws=new WebSocket('ws://'+location.host+'/socket');ws.onopen=()=>ws.send('echo');ws.onmessage=()=>{wsReady=true;render()};
      async function render(){const policy=await navigator.permissions.query({name:'clipboard-write'});const configurable=Object.getOwnPropertyDescriptor(Document.prototype,'execCommand')?.configurable;if(navigator.clipboard||configurable!==false||policy.state!=='denied'){document.title='Clipboard guard '+Boolean(navigator.clipboard)+' '+configurable+' '+policy.state;return}const value=await(await fetch('/api/counter')).json();document.title='Application '+value.count+' '+wsReady;document.querySelector('#add').textContent='Add one: '+value.count}document.querySelector('#add').onclick=async()=>{await fetch('/api/counter',{method:'POST'});localStorage.saved='yes';await render()};render();</script>`, { headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } })
    }, websocket: { open() { activeSockets++ }, close() { activeSockets-- }, message(ws, message) { ws.send(message) } },
  })
  servers.push(app)
  const appOrigin = `http://127.0.0.1:${app.port}`
  for (const directory of [projectPath, outsidePath]) await writeFile(path.join(directory, "README.md"),
    await readFile(path.join(directory, "README.md"), "utf8") + `\n[Host HTTP application](${appOrigin}/app?tab=one#section)\n`)
  await server.store.appendMessage(chat.id, { kind: "assistant_text", _id: "preview-fixture-links", createdAt: Date.now(),
    text: `[Read guide](<${path.join(projectPath, "README.md").replaceAll("\\", "/")}>) · [HTML sample](<${path.join(projectPath, "index.html").replaceAll("\\", "/")}>) · [HTTP application](${appOrigin}/app?tab=one#section) · [Image sample](<${path.join(projectPath, "中文 image.png").replaceAll("\\", "/")}>) · [Text sample](<${path.join(projectPath, "中文 text.txt").replaceAll("\\", "/")}>) · [Office sample](<${path.join(projectPath, "sample.docx").replaceAll("\\", "/")}>) · [External website](https://example.com/report.html) · [External HTTP](http://example.com/report.md)` })
  const addresses: Record<string, Record<string, string>> = {}
  const targetIds: Record<string, Record<string, string>> = {}
  for (const entry of entries) {
    const outside = await json(entry, "/api/local-html-previews", { filePath: path.join(outsidePath, "index.html") })
    addresses[entry.name] = { "project-markdown": `/api/projects/${project.id}/markdown-preview/README.md`,
      "outside-markdown": `/api/local-files/markdown-preview/${encodeURIComponent(path.join(outsidePath, "README.md"))}`,
      "project-html": `/api/projects/${project.id}/preview/index.html`, "outside-html": outside.url,
      "project-text": `/api/projects/${project.id}/preview/${encodeURIComponent("中文 text.txt")}`,
      "outside-text": `/api/local-files/preview/${encodeURIComponent(path.join(outsidePath, "中文 text.txt"))}`,
      "project-image": `/api/projects/${project.id}/preview/${encodeURIComponent("中文 image.png")}`,
      "outside-image": `/api/local-files/preview/${encodeURIComponent(path.join(outsidePath, "中文 image.png"))}`,
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
      if (name !== "dynamic") {
        const response = await request(entry, `/api/preview-targets/${target.id}/content?download=1`)
        assert.equal(response.status, 200)
        const fileName = name.endsWith("html") ? "index.html" : name.endsWith("text") ? "中文 text.txt" : "中文 image.png"
        const bytes = await readFile(path.join(name.startsWith("outside") ? outsidePath : projectPath, fileName))
        assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), createHash("sha256").update(bytes).digest("hex"))
        if (name.endsWith("html")) {
          const value = await json(entry, `/api/file-previews/${target.id}/entry`, {})
          assert.equal(value.protocol, 1); assert.equal(typeof value.url, "string")
          const destination = new URL(value.url)
          const response = await fetch((entry.gateway ?? `http://127.0.0.1:${destination.port}`) + destination.pathname, { headers: { Host: destination.host } })
          assert.equal(response.status, 200)
          assert((await response.text()).includes("ES module") || response.headers.get("content-type")?.includes("text/html"))
        }
        checks.push({ entry: entry.name, check: name + " authenticated original bytes and direct renderer contract", result: "Pass" })
        continue
      }
      if (filesOnly) continue
      const session = await json(entry, "/api/preview-browser", { targetId: target.id })
      for (const key of ["Control+C", "Control+V", "Meta+X", "Shift+Delete"]) {
        assert.equal((await request(entry, "/api/preview-browser/" + session.id, { type: "key", key })).status, 400)
      }
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
      checks.push({ entry: entry.name, check: name + " resources, input, storage, reload, clipboard guards" + (name === "dynamic" ? ", API, WebSocket, bidirectional writes, deep navigation" : ""), result: "Pass" })
      await request(entry, "/api/preview-browser/" + session.id, undefined, "DELETE")
    }
    stage = entry.name + ":original-downloads-and-host-action-denial"
    for (const directory of [projectPath, outsidePath]) for (const fileName of ["README.md", "index.html", "中文 text.txt", "中文 image.png", "sample.docx", "sample.pptx"]) {
      const address = directory === projectPath ? `/api/projects/${project.id}/preview/${encodeURIComponent(fileName)}` : `/api/local-files/preview/${encodeURIComponent(path.join(directory, fileName))}`
      const target = await json(entry, "/api/preview-targets", { projectId: project.id, address })
      const response = await request(entry, `/api/preview-targets/${target.id}/content?download=1`)
      assert.equal(response.status, 200); assert(response.headers.get("content-disposition")?.includes(encodeURIComponent(fileName)))
      const originalBytes = Buffer.from(await response.arrayBuffer())
      const actual = createHash("sha256").update(originalBytes).digest("hex")
      downloads.push({ entry: entry.name, scope: directory === projectPath ? "workspace" : "authorized-host-file", name: fileName, size: originalBytes.length, sha256: actual, contentType: response.headers.get("content-type") })
      assert.equal(actual, createHash("sha256").update(await readFile(path.join(directory, fileName))).digest("hex"))
      if (entry.name !== "loopback") for (const action of ["open_default", "open_finder"]) {
        const denied = await request(entry, `/api/preview-targets/${target.id}/action`, { action, local: true })
        assert.equal(denied.status, 403, `${entry.name} ${action} ${fileName}: ${await denied.text()}`)
      }
    }
    checks.push({ entry: entry.name, check: "Project and authorized host-file original MD/HTML/TXT/image/Office hashes and UTF-8 filenames", result: "Pass" })
    if (!filesOnly) {
    const protectedResponse = await request(entry, "/api/preview-targets", { address: localOrigin, projectId: project.id })
    assert.equal(protectedResponse.status, 403, "Control application cannot become a preview target")
    checks.push({ entry: entry.name, check: "StillOn control port denied", result: "Pass" })
    for (const variant of ["no-title", "root-404", "slow-root", "application-401", "application-403", "application-500", "ipv6-listener"]) {
      stage = entry.name + ":" + variant
      const variantServer = Bun.serve({ hostname: variant === "ipv6-listener" ? "::1" : "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/" && variant === "slow-root") await Bun.sleep(900)
        if (url.pathname === "/" && variant === "root-404") return new Response("Not found", { status: 404 })
        return new Response("<!doctype html><h1>Explicit application path</h1><script>document.title='Variant ready'</script>", { status: variant.startsWith("application-") ? Number(variant.slice(12)) : 200, headers: { "Content-Type": "text/html" } })
      } })
      servers.push(variantServer)
      const address = `http://${variant === "ipv6-listener" ? "[::1]" : "localhost"}:${variantServer.port}/app?variant=${variant}#section`
      const target = await json(entry, "/api/preview-targets", { projectId: project.id, address })
      const session = await json(entry, "/api/preview-browser", { targetId: target.id })
      const frame = await json(entry, "/api/preview-browser/" + session.id)
      assert.equal(frame.title, "Variant ready"); assert.equal(frame.address, address)
      await request(entry, "/api/preview-browser/" + session.id, undefined, "DELETE")
      checks.push({ entry: entry.name, check: "Explicit path admission: " + variant, result: "Pass" })
    }
    for (const address of ["https://example.com/report.html", "http://example.com/report.md", "https://localhost.example.com/"]) {
      assert.equal((await request(entry, "/api/preview-targets", { projectId: project.id, address })).status, 400)
    }
    checks.push({ entry: entry.name, check: "External websites never create preview targets", result: "Pass" })
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
    serviceListPort = restored.port!
    servers.push(restored)
    const retried = await json(entry, "/api/preview-browser", { targetId: recoveryTarget.id })
    assert.equal(retried.id, recoverySession.id, "Retry reopens the same target with an explicit GET")
    const recovered = await eventually(() => json(entry, "/api/preview-browser/" + recoverySession.id), value => value.title === "Service restored" && !value.error)
    assert.equal(recovered.address, recoveryAddress)
    await writeFile(path.join(output, entry.name + "-recovery-unavailable.jpg"), Buffer.from(unavailable.image, "base64"))
    await writeFile(path.join(output, entry.name + "-recovery-restored.jpg"), Buffer.from(recovered.image, "base64"))
    await request(entry, "/api/preview-browser/" + recoverySession.id, undefined, "DELETE")
    checks.push({ entry: entry.name, check: "Stopped service recovers immediately at the same deep target without a negative cache", result: "Pass" })
    }
  }
  if (entries[1]) {
    const stolen = await request(entries[0]!, "/api/preview-targets/" + targetIds[entries[1].name]!["project-html"])
    assert.equal(stolen.status, 410)
    checks.push({ entry: "cross-entry", check: "Opaque target ID does not grant another owner access", result: "Pass" })
  }
  if (!filesOnly) {
  stage = "service-list-discovery"
  assert((await listLocalHttpServers({ projectPath })).some(service => service.port === serviceListPort && service.title === "Service restored"), "The restored fixture must appear in real service discovery")
  stage = "browser-authorization-expiry"
  const leasedBrowser = new PreviewBrowser({ blockedPorts: () => [], resolveFile: async () => { throw new Error("No file grant") } })
  try {
    let leasedAddress = appOrigin + "/input?case=pointer-lifecycle"
    // Real Connect requests carry a freshly signed lease on every call. A
    // fixed initial lease incorrectly expires unrelated pointer checks on a
    // slower native runner, before the explicit 200ms expiry test below.
    const options = () => ({ owner: "fixture-owner", scope: "fixture-owner:parent-session", expiresAt: Date.now() + 45_000,
      target: () => ({ target: { kind: "host-http" as const, address: leasedAddress } }) })
    stage = "browser-lifecycle:open"
    const opened = await leasedBrowser.handle(new Request("http://stillon.invalid/api/preview-browser", {
      method: "POST", body: JSON.stringify({ targetId: "fixture", viewerId: "pointer-owner" }), headers: { "Content-Type": "application/json" },
    }), new URL("http://stillon.invalid/api/preview-browser"), options())
    assert.equal(opened?.status, 200)
    const session = await opened!.json() as { id: string }
    const pointerState = async () => await (await fetch(appOrigin + "/input-state?case=pointer-lifecycle")).json() as any
    stage = "browser-lifecycle:input-ready"
    await eventually(pointerState, value => value.revision > 0)
    const pointerRoute = (viewer: string) => new URL("http://stillon.invalid/api/preview-browser/" + session.id + "?viewer=" + viewer)
    const pointerAction = async (phase: string, viewer = "pointer-owner", y = 230) => {
      const url = pointerRoute(viewer)
      return await leasedBrowser.handle(new Request(url, { method: "POST", body: JSON.stringify({ type: "pointer", phase,
        pointerId: 1, pointerType: "mouse", button: 0, buttons: phase === "down" ? 1 : 0, x: 50, y }) }), url, options())
    }
    const input = async (action: object) => {
      const url = pointerRoute("pointer-owner")
      return await leasedBrowser.handle(new Request(url, { method: "POST", body: JSON.stringify({ ...action, inputOnly: true }) }), url, options())
    }
    stage = "browser-lifecycle:cross-tab-keyboard"
    assert.equal((await input({ type: "click", x: 50, y: 120 }))?.status, 200)
    assert.equal((await input({ type: "text", text: "hello" }))?.status, 200)
    const foreground = new URL("http://stillon.invalid/api/preview-browser")
    const originalAddress = leasedAddress
    leasedAddress = leasedAddress.replace("127.0.0.1", "localhost").replace("pointer-lifecycle", "other-tab")
    assert.equal((await leasedBrowser.handle(new Request(foreground, { method: "POST", body: JSON.stringify({ targetId: "other", viewerId: "other-tab" }) }), foreground, options()))?.status, 200)
    leasedAddress = originalAddress
    assert.equal((await input({ type: "key", key: "Space" }))?.status, 200)
    stage = "browser-lifecycle:space-commit"
    await eventually(pointerState, value => value.text === "hello ")
    checks.push({ entry: "keyboard-focus", check: "Native Space reaches an editor after another isolated tab becomes active", result: "Pass" })
    stage = "browser-lifecycle:pointer-owner"
    assert.equal((await pointerAction("down"))?.status, 200)
    await eventually(pointerState, value => value.down)
    const secondViewer = new URL("http://stillon.invalid/api/preview-browser")
    assert.equal((await leasedBrowser.handle(new Request(secondViewer, { method: "POST", body: JSON.stringify({ targetId: "fixture", viewerId: "another-viewer" }) }), secondViewer, options()))?.status, 200)
    assert.equal((await pointerAction("up", "another-viewer"))?.status, 400)
    assert.equal((await pointerState()).down, true)
    // Background session keepalives must not hold a lost pointer indefinitely.
    const heartbeat = setInterval(() => {
      const url = new URL(pointerRoute("pointer-owner") + "&ping=1")
      void leasedBrowser.handle(new Request(url), url, options())
    }, 500)
    stage = "browser-lifecycle:lost-pointer-watchdog"
    try { await eventually(pointerState, value => !value.down, 8_000) } finally { clearInterval(heartbeat) }
    stage = "browser-lifecycle:viewer-release"
    assert.equal((await pointerAction("down", "pointer-owner", 420))?.status, 200)
    const owner = pointerRoute("pointer-owner")
    assert.equal((await leasedBrowser.handle(new Request(owner, { method: "DELETE" }), owner, options()))?.status, 200)
    await eventually(pointerState, value => !value.down)
    assert.equal((await pointerState()).activations, 0, "Cancelling a held pointer must not activate its button")
    assert.equal((await pointerAction("down"))?.status, 410)
    checks.push({ entry: "pointer-lifecycle", check: "Viewer ownership, lost-pointer watchdog despite background heartbeats, release and stale-input rejection", result: "Pass" })
    leasedAddress = appOrigin + "/app"
    stage = "browser-lifecycle:expiry-open"
    assert.equal((await leasedBrowser.handle(new Request(secondViewer, { method: "POST", body: JSON.stringify({ targetId: "fixture", viewerId: "another-viewer" }) }), secondViewer, options()))?.status, 200)
    stage = "browser-lifecycle:expiry-wait-websocket"
    await eventually(async () => activeSockets, value => value === 1)
    const route = new URL("http://stillon.invalid/api/preview-browser/" + session.id + "?ping=1")
    const ping = await leasedBrowser.handle(new Request(route), route, { ...options(), expiresAt: Date.now() + 200 })
    assert.equal(ping?.status, 200)
    stage = "browser-lifecycle:expiry-wait-close"
    await eventually(async () => activeSockets, value => value === 0)
    assert.equal((await leasedBrowser.handle(new Request(route), route, { ...options(), expiresAt: Date.now() + 10_000 }))?.status, 410)
    checks.push({ entry: "scope-expiry", check: "Expired parent authorization closes the isolated browser and its live application WebSocket", result: "Pass" })
  } catch (error) { console.error("Browser lifecycle failure at " + stage + "; active application sockets: " + activeSockets); throw error }
  finally { stage = "browser-lifecycle:close"; await leasedBrowser.close() }
  }
  await writeFile(path.join(output, filesOnly ? "api-results-files-only.json" : "api-results.json"), JSON.stringify({ localOnly, filesOnly, commit: sourceCommit, dirty, downloads, checks }, null, 2))
  console.log(JSON.stringify({ localOnly, checks }, null, 2))
  if (browserOutput) {
    clearInterval(progress)
    const assetDirectory = path.resolve("dist/client/assets")
    const modules = await Promise.all((await readdir(assetDirectory)).filter(name => /^download-[a-f0-9]{12}\.js$/u.test(name))
      .map(async name => ({ name, size: (await readFile(path.join(assetDirectory, name))).length })))
    const probeModule = modules.sort((a, b) => a.size - b.size)[0]
    assert(probeModule, "The built download module must exist for transport integrity checks")
    await writeFile(path.resolve(browserOutput), JSON.stringify({ entries, addresses, targetIds, projectId: project.id, chatId: chat.id, appOrigin, serviceListPort, outsidePath, projectPath, fixtureRoot: root, output, moduleProbeAsset: "/assets/" + probeModule.name, gatewayVersion: sourceCommit, sourceVersion: sourceCommit, dirty, hostOS: os.platform(), hostRelease: os.release(), adapterVersion: sourceCommit, clientVersion: sourceCommit }))
    console.log("Workspace browser fixture ready")
    if (stopFile) { while (true) { try { await readFile(stopFile); break } catch { await Bun.sleep(200) } } }
    else await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
  }
} catch (error) {
  console.error("Preview fixture failed at " + stage)
  throw error
} finally {
  clearInterval(progress)
  for (const app of servers) await app.stop(true)
  if (connect) await connect.stop(); else await server.stop()
  // Only the explicitly generated temporary fixture root is removed.
  if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("stillon-workspace-previews-")) await rm(root, { recursive: true, force: true })
}
