import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ProviderAddons, parseAddonPackage } from "./provider-addons"
import { handleProviderAddons } from "./provider-addons-http"
import { workspaceHttpAllowed } from "./workspace-access"
import { addonEnvironment } from "./addon-process"
import type { HarnessEvent } from "./harness-types"
import { harnessModelId } from "../shared/harness-models"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-addon-test-")); roots.push(root)
  const manager = new ProviderAddons(root, () => ({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP }))
  await manager.initialize(); return { root, manager }
}
function bundle(version = "0.1.0", identityVersion = version, modelManagement = false, provider: "deepseek" | "codebuddy" = "deepseek") {
  const code = `import { createInterface } from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const input = createInterface({input:process.stdin});
let pending;
input.on('line', line => {
 const f=JSON.parse(line), p=f.params;
 if(f.method==='hello') send({id:f.id,result:{api:1,id:${JSON.stringify(provider)},version:${JSON.stringify(identityVersion)}}});
 if(f.method==='status') send({id:f.id,result:{provider:${JSON.stringify(provider)},state:'ready',installed:true,canOpenTerminal:false,platform:process.platform}});
 if(f.method==='configuration')send({id:f.id,result:{profile:'sdk',services:[]}});
 if(f.method==='discover') {
   if(p.provider==='fail')send({id:f.id,error:'Discovery failed'});
   else send({id:f.id,result:[{id:'dsh:'+p.provider+':same-model',provider:p.provider,model:'same-model',label:p.provider+' model',supportsEffort:true,efforts:[{id:'medium',label:'Medium'}]}]});
 }
 if(f.method==='configure') setTimeout(()=>send({id:f.id,result:{ok:true}}),100);
 if(f.method==='start') {
  send({id:f.id,result:{started:true}});
  send({event:{type:'session_token',sessionToken:p.sessionToken||'synthetic-session'}});
  if(p.content==='hold') return;
  const finish = text => {send({event:{type:'transcript',entry:{_id:'entry',createdAt:1,kind:'assistant_text',text}}});send({done:true})};
  if(p.content==='question') { pending=finish;send({questionId:1,question:{tool:{kind:'tool',toolName:'AskUserQuestion',toolKind:'ask_user_question',toolId:'q',input:{questions:[{id:'answer',question:'Continue?'}]}}}}); }
  else finish(p.sessionToken?'resumed':'new');
 }
 if(f.method==='answer'){send({id:f.id,result:{ok:true}});pending(JSON.stringify(p.answer));}
 if(f.method==='shutdown')send({id:f.id,result:{stopped:true}});
}); input.on('close',()=>process.exit(0));`
  return parseAddonPackage({ manifest: { format: 1, id: provider, name: "Synthetic Harness", version, hostApi: 1,
    targets: [`${process.platform}-${process.arch}`], testedCliVersions: ["0.2.1-rc.5"],
    catalog: { id: provider, label: "Synthetic", defaultModel: "model", models: [{ id: "model", label: "Model", supportsEffort: false }], efforts: [] },
    capabilities: { resume: true, fork: false, images: false, streaming: false, questions: true, permissions: ["request"], ...(modelManagement ? { modelManagement: true } : {}) },
    sha256: createHash("sha256").update(code).digest("hex") }, code })
}
const turnArgs = (cwd: string, content = "hello", sessionToken: string | null = null) => ({ cwd, content, sessionToken, model: "model", permissionMode: "request", onToolRequest: async () => ({ discarded: true }) })

async function bundledRuntime(root: string, version = "0.2.0") {
  const directory = path.join(root, `runtime-${version}`, "dist/integrations")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "deepseek.stillon-addon"), JSON.stringify(bundle(version, version, true)))
  await writeFile(path.join(directory, "codebuddy.stillon-addon"), JSON.stringify(bundle(version, version, false, "codebuddy")))
  return directory
}

test("bundled integrations are visible but disabled on first launch; no adapter environment or process is needed", async () => {
  const { root } = await fixture(), directory = await bundledRuntime(root)
  const manager = new ProviderAddons(root, () => { throw new Error("Disabled adapters must not launch") })
  await manager.initialize(directory)
  expect(manager.snapshot().map(({ id, enabled, bundled }) => ({ id, enabled, bundled }))).toEqual([
    { id: "deepseek", enabled: false, bundled: true }, { id: "codebuddy", enabled: false, bundled: true },
  ])
  expect(manager.providers()).toEqual([])
  await expect(manager.startTurn("deepseek", turnArgs(root))).rejects.toThrow("Enable")
  const url = new URL("http://localhost:3220/api/providers")
  const response = await handleProviderAddons(new Request(url), url, manager, false)
  expect((await response!.json()).providers.map((p: any) => p.id)).toEqual(["claude", "codex"])
  const registry = await readFile(path.join(root, "addons/installed.json"), "utf8")
  const restarted = new ProviderAddons(root, () => { throw new Error("No startup probe") }); await restarted.initialize(directory)
  expect(await readFile(path.join(root, "addons/installed.json"), "utf8")).toBe(registry)
  expect(restarted.providers()).toEqual([])
})

test("bundled toggles are independent, persist, enforce owner origin and refuse disabling active chats", async () => {
  const { root } = await fixture(), directory = await bundledRuntime(root), manager = new ProviderAddons(root)
  await manager.initialize(directory)
  const url = new URL("http://localhost:3220/api/addons")
  const toggle = (id: string, action: string, local = true, origin = url.origin) => handleProviderAddons(new Request(url,
    { method: "POST", headers: { origin }, body: JSON.stringify({ id, action }) }), url, manager, local)
  expect((await toggle("deepseek", "enable", false))?.status).toBe(403)
  expect((await toggle("deepseek", "enable", true, "https://foreign.example"))?.status).toBe(403)
  expect(manager.providers()).toEqual([])
  expect((await toggle("deepseek", "enable"))?.status).toBe(200)
  expect(manager.providers().map(p => p.id)).toEqual(["deepseek"])
  await manager.change("codebuddy", "enable")
  const turn = await manager.startTurn("deepseek", turnArgs(root, "hold")), stream = turn.stream[Symbol.asyncIterator]()
  await stream.next()
  expect((await toggle("deepseek", "disable"))?.status).toBe(400)
  expect(manager.providers()).toHaveLength(2)
  await turn.interrupt(); await stream.return?.()
  expect((await toggle("deepseek", "disable"))?.status).toBe(200)
  const restarted = new ProviderAddons(root); await restarted.initialize(directory)
  expect(restarted.providers().map(p => p.id)).toEqual(["codebuddy"])
  await expect(restarted.install(bundle("0.3.0"))).rejects.toThrow("included with StillOn")
  for (const action of ["uninstall", "rollback"] as const) await expect(restarted.change("codebuddy", action)).rejects.toThrow("update with StillOn")
}, 15_000)

test("app updates and rollback select their bundled versions while retaining enabled state, models and history", async () => {
  const { root, manager: oldPreview } = await fixture()
  await oldPreview.install(bundle("0.1.0", "0.1.0", true))
  const id = harnessModelId("gateway", "same-model")
  await oldPreview.modelOperation("deepseek", "discover", { provider: "gateway" })
  await oldPreview.selectModels("deepseek", { ids: [id], defaultModel: id })
  const policyFile = path.join(root, "addons/deepseek/models.json"), policy = await readFile(policyFile, "utf8")
  const history = path.join(root, "synthetic-history.json"); await writeFile(history, JSON.stringify({ sessionToken: "synthetic-session" }))
  const firstDirectory = await bundledRuntime(root), first = new ProviderAddons(root); await first.initialize(firstDirectory)
  expect(first.snapshot().map(p => [p.version, p.enabled])).toEqual([["0.2.0", true], ["0.2.0", false]])
  expect(first.getCatalog("deepseek").defaultModel).toBe(id)
  await first.change("deepseek", "disable"); await first.change("codebuddy", "enable")
  const secondDirectory = await bundledRuntime(root, "0.3.0"), second = new ProviderAddons(root); await second.initialize(secondDirectory)
  expect(second.snapshot().map(p => [p.version, p.enabled])).toEqual([["0.3.0", false], ["0.3.0", true]])
  const rolledBack = new ProviderAddons(root); await rolledBack.initialize(firstDirectory)
  expect(rolledBack.snapshot().map(p => [p.version, p.enabled])).toEqual([["0.2.0", false], ["0.2.0", true]])
  await rolledBack.change("deepseek", "enable")
  expect(rolledBack.getCatalog("deepseek").defaultModel).toBe(id)
  const turn = await rolledBack.startTurn("deepseek", { ...turnArgs(root, "hello", "synthetic-session"), model: id, effort: "medium" })
  const events: HarnessEvent[] = []; for await (const event of turn.stream) events.push(event)
  expect(events.some(event => event.entry?.kind === "assistant_text" && event.entry.text === "resumed")).toBe(true)
  expect(await readFile(policyFile, "utf8")).toBe(policy)
  expect(JSON.parse(await readFile(history, "utf8")).sessionToken).toBe("synthetic-session")
}, 20_000)

test("a damaged bundled update fails closed without changing preferences or the other integration", async () => {
  const { root } = await fixture(), initial = await bundledRuntime(root), manager = new ProviderAddons(root)
  await manager.initialize(initial); await manager.change("deepseek", "enable")
  const damaged = await bundledRuntime(root, "0.3.0"), bad = bundle("0.3.0"); bad.code += "//tampered"
  await writeFile(path.join(damaged, "deepseek.stillon-addon"), JSON.stringify(bad))
  const updated = new ProviderAddons(root); await updated.initialize(damaged)
  expect(updated.snapshot().find(p => p.id === "deepseek")).toMatchObject({ version: "0.2.0", enabled: true, compatible: false })
  expect(updated.snapshot().find(p => p.id === "codebuddy")).toMatchObject({ version: "0.3.0", enabled: false, compatible: true })
  expect(updated.providers()).toEqual([])
  await expect(updated.startTurn("deepseek", turnArgs(root))).rejects.toThrow("missing or damaged")
  await updated.change("deepseek", "disable")
  const recovered = new ProviderAddons(root); await recovered.initialize(initial)
  expect(recovered.snapshot().find(p => p.id === "deepseek")).toMatchObject({ enabled: false, compatible: true })
})

test("unsupported bundled platform is shown unavailable and never activated; corrupt registry is not reset", async () => {
  const { root } = await fixture(), directory = await bundledRuntime(root)
  const other = bundle("0.2.0"); other.manifest.targets = [process.platform === "win32" ? "darwin-arm64" : "win32-arm64"]
  await writeFile(path.join(directory, "deepseek.stillon-addon"), JSON.stringify(other))
  const manager = new ProviderAddons(root); await manager.initialize(directory)
  expect(manager.snapshot().find(p => p.id === "deepseek")).toMatchObject({ enabled: false, compatible: false })
  await expect(manager.change("deepseek", "enable")).rejects.toThrow("platform")
  const registry = path.join(root, "addons/installed.json"); await writeFile(registry, "damaged-registry")
  const restarted = new ProviderAddons(root); await restarted.initialize(directory)
  expect(restarted.providers()).toEqual([])
  await expect(restarted.change("codebuddy", "enable")).rejects.toThrow("registry is damaged")
  expect(await readFile(registry, "utf8")).toBe("damaged-registry")
})

test("Harness discovery is a draft; selected routes and per-model efforts persist without conflating model IDs", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle("0.2.0", "0.2.0", true))
  const first = harnessModelId("gateway-a", "same-model"), second = harnessModelId("gateway-b", "same-model")
  await manager.modelOperation("deepseek", "discover", { provider: "gateway-a" })
  await manager.modelOperation("deepseek", "discover", { provider: "gateway-b" })
  expect(manager.providers()[0]?.defaultModel).toBe("model")
  await manager.selectModels("deepseek", { ids: [first, second], defaultModel: second })
  await expect(manager.modelOperation("deepseek", "discover", { provider: "fail" })).rejects.toThrow("Discovery failed")
  await expect(manager.selectModels("deepseek", { ids: ["unknown"], defaultModel: "unknown" })).rejects.toThrow("Discover")
  const restarted = new ProviderAddons(root); await restarted.initialize()
  expect(restarted.providers()[0]?.models.map(model => model.id)).toEqual([first, second])
  expect(restarted.providers()[0]?.defaultModel).toBe(second)
  await expect(restarted.startTurn("deepseek", { ...turnArgs(root), model: first, effort: "high" })).rejects.toThrow("reasoning effort")
  await expect(restarted.startTurn("deepseek", turnArgs(root))).rejects.toThrow("not enabled")
  const turn = await restarted.startTurn("deepseek", { ...turnArgs(root), model: first, effort: "medium" })
  for await (const _ of turn.stream) { /* The enabled exact route is admitted. */ }
  expect(JSON.parse(await readFile(path.join(root, "addons/deepseek/models.json"), "utf8")).models).toHaveLength(2)
}, 20_000)

test("Harness configuration enforces local origin, bounded input and workspace isolation", async () => {
  const { manager } = await fixture(), url = new URL("http://localhost:3219/api/addons/deepseek/models")
  await manager.install(bundle("0.2.0", "0.2.0", true))
  for (const [local, method, origin] of [[false, "GET", url.origin], [false, "POST", url.origin], [true, "POST", "https://foreign.example"]] as const) {
    const response = await handleProviderAddons(new Request(url, { method, headers: { origin }, ...(method === "POST" ? { body: "{}" } : {}) }), url, manager, local)
    expect(response?.status).toBe(403)
  }
  expect(workspaceHttpAllowed(url, "GET", "workspace")).toBe(false)
  expect(workspaceHttpAllowed(url, "POST", "workspace")).toBe(false)
  const secret = "synthetic-write-only-key"
  const invalid = await handleProviderAddons(new Request(url, { method: "POST", headers: { origin: url.origin }, body: JSON.stringify({ action: "configure", input: { provider: "test", apiKey: secret, unexpected: secret } }) }), url, manager, true)
  expect(invalid?.status).toBe(400); expect(await invalid!.text()).not.toContain(secret)
  const oversized = await handleProviderAddons(new Request(url, { method: "POST", headers: { origin: url.origin }, body: " ".repeat(128 * 1024 + 1) }), url, manager, true)
  expect(oversized?.status).toBe(400)
}, 10_000)

test("Harness writes wait for chats; damaged policies refuse sends and can be repaired through discovery", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle("0.2.0", "0.2.0", true))
  const turn = await manager.startTurn("deepseek", turnArgs(root, "hold"))
  const stream = turn.stream[Symbol.asyncIterator](); await stream.next()
  await expect(manager.modelOperation("deepseek", "configure", {})).rejects.toThrow("Stop")
  await turn.interrupt(); await stream.return?.()
  await writeFile(path.join(root, "addons/deepseek/models.json"), "damaged")
  const restarted = new ProviderAddons(root); await restarted.initialize()
  await expect(restarted.startTurn("deepseek", turnArgs(root))).rejects.toThrow("damaged")
  expect(await readFile(path.join(root, "addons/deepseek/models.json"), "utf8")).toBe("damaged")
  const id = harnessModelId("gateway", "same-model")
  await restarted.modelOperation("deepseek", "discover", { provider: "gateway" })
  await restarted.selectModels("deepseek", { ids: [id], defaultModel: id })
  expect(restarted.modelState("deepseek").error).toBeUndefined()
}, 15_000)

test("clean host has only built-ins; install, persist, disable, reinstall and resume without host rebuild", async () => {
  const { root, manager } = await fixture()
  const response = await handleProviderAddons(new Request("http://localhost:3217/api/providers"), new URL("http://localhost:3217/api/providers"), manager, true)
  expect((await response!.json()).providers.map((provider: any) => provider.id)).toEqual(["claude", "codex"])
  await manager.install(bundle())
  expect(manager.providers().map(provider => provider.id)).toEqual(["deepseek"])
  const turn = await manager.startTurn("deepseek", turnArgs(root))
  const events: HarnessEvent[] = []; for await (const event of turn.stream) events.push(event)
  expect(events[0]?.sessionToken).toBe("synthetic-session")
  await manager.change("deepseek", "disable")
  expect(() => manager.require("deepseek")).toThrow("Settings → Integrations")
  await manager.change("deepseek", "enable")
  await manager.change("deepseek", "uninstall")
  expect(manager.providers()).toEqual([])
  await manager.install(bundle())
  const restarted = new ProviderAddons(root); await restarted.initialize()
  const resumed = await restarted.startTurn("deepseek", turnArgs(root, "hello", "synthetic-session"))
  const resumedEvents: HarnessEvent[] = []; for await (const event of resumed.stream) resumedEvents.push(event)
  expect(resumedEvents.some(event => event.entry?.kind === "assistant_text" && event.entry.text === "resumed")).toBe(true)
}, 30_000)

test("active turn pins the package; Stop releases it before removal", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle())
  const turn = await manager.startTurn("deepseek", turnArgs(root, "hold"))
  const stream = turn.stream[Symbol.asyncIterator](); await stream.next()
  await expect(manager.change("deepseek", "uninstall")).rejects.toThrow("Wait for")
  await expect(manager.install(bundle("0.2.0"))).rejects.toThrow("Wait for")
  await turn.interrupt(); await stream.return?.()
  expect(manager.snapshot()[0]?.busy).toBe(false)
  await manager.change("deepseek", "uninstall")
}, 20_000)

test("questions round trip and dismissal stays a rejection", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle())
  const turn = await manager.startTurn("deepseek", turnArgs(root, "question"))
  const events: HarnessEvent[] = []; for await (const event of turn.stream) events.push(event)
  expect(events.some(event => event.entry?.kind === "assistant_text" && event.entry.text.includes('"discarded":true'))).toBe(true)
}, 15_000)

test("upgrade and rollback survive host restart; failed validation preserves installed version", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle())
  const incompatible = bundle("0.2.0"); incompatible.manifest.hostApi = 99
  await expect(manager.install(incompatible)).rejects.toThrow("API version")
  await expect(manager.install(bundle("0.2.0", "wrong"))).rejects.toThrow("identity")
  expect(manager.snapshot()[0]?.version).toBe("0.1.0")
  await manager.install(bundle("0.3.0"))
  const restarted = new ProviderAddons(root); await restarted.initialize()
  expect(restarted.snapshot()[0]?.previousVersion).toBe("0.1.0")
  await restarted.change("deepseek", "rollback")
  expect(restarted.snapshot()[0]?.version).toBe("0.1.0")
}, 20_000)

test("tampered code and malformed package IDs do not execute", async () => {
  const { root, manager } = await fixture()
  const bad = bundle(); bad.code += "// tamper"
  await expect(manager.install(bad)).rejects.toThrow("checksum")
  const traversal = { ...bundle().manifest, id: "../../outside" }
  await expect(manager.install({ manifest: traversal, code: bundle().code })).rejects.toThrow()
  await manager.install(bundle())
  await writeFile(path.join(root, "addons/deepseek/0.1.0/adapter.js"), "throw new Error('should not execute')")
  await expect(manager.startTurn("deepseek", turnArgs(root))).rejects.toThrow("checksum")
  expect(manager.snapshot()[0]?.busy).toBe(false)
  const restarted = new ProviderAddons(root); await restarted.initialize()
  expect(restarted.providers()).toEqual([])
  expect(restarted.snapshot()[0]?.compatible).toBe(false)
}, 15_000)

test("local origin and owner boundaries protect package management", async () => {
  const { manager } = await fixture(), url = new URL("http://localhost:3217/api/addons")
  for (const [local, origin] of [[false, url.origin], [true, "https://foreign.example"], [true, ""]] as const) {
    const response = await handleProviderAddons(new Request(url, { method: "POST", headers: { origin }, body: "{}" }), url, manager, local)
    expect(response?.status).toBe(403)
  }
  expect(workspaceHttpAllowed(url, "POST", "workspace")).toBe(false)
  expect(workspaceHttpAllowed(new URL("http://localhost:3217/api/providers"), "GET", "workspace")).toBe(true)
  expect(addonEnvironment({ STILLON_UPDATE_SECRET: "test", STILLON_CONNECT_SECRET: "test", OPENAI_API_KEY: "test", DSH_HOME: "test-home", HTTPS_PROXY: "test-proxy" }))
    .toEqual({ DSH_HOME: "test-home", HTTPS_PROXY: "test-proxy" })
})

test("damaged registry remains intact and leaves built-ins available", async () => {
  const { root, manager } = await fixture(); await manager.install(bundle())
  const file = path.join(root, "addons/installed.json")
  await writeFile(file, "incomplete write")
  const restarted = new ProviderAddons(root); await restarted.initialize()
  expect(restarted.providers()).toEqual([])
  await expect(restarted.install(bundle())).rejects.toThrow("registry is damaged")
  expect(await readFile(file, "utf8")).toBe("incomplete write")
}, 15_000)
