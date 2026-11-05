import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCodeBuddyAddon, buildDeepSeekAddon } from "../../scripts/build-provider-addon"
import { codeBuddyCandidates, codeBuddyCommand, discoverCodeBuddy } from "../../addons/codebuddy/src/codebuddy-cli"
import { codeBuddyArgs, codeBuddyTranscript, startCodeBuddyTurn } from "../../addons/codebuddy/src/codebuddy-harness"
import { ProviderAddons } from "./provider-addons"
import { handleProviderAddons } from "./provider-addons-http"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import type { HarnessEvent, HarnessToolRequest } from "./harness-types"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const fakeCli = `
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync } from 'node:fs';
if(process.argv.includes('--version')){console.log('2.180.0 (CodeBuddy Code)');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const input=createInterface({input:process.stdin});
const resumeIndex=process.argv.indexOf('--resume');
const session=resumeIndex<0?'fixture-session':process.argv[resumeIndex+1];
const finish=text=>{send({type:'assistant',message:{content:[{type:'text',text}]}});send({type:'result',subtype:'success',is_error:false,result:text})};
writeFileSync('cli-start.json',JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));
input.on('line',line=>{
 const f=JSON.parse(line);
 if(f.type==='control_request') {
  if(f.request.subtype==='initialize') send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{account:{token:'PRIVATE_INIT_TOKEN'}}}});
  if(f.request.subtype==='interrupt'){writeFileSync('interrupted','yes');send({type:'control_response',response:{subtype:'success',request_id:f.request_id}})}
 }
 if(f.type==='user') {
  send({type:'system',subtype:'init',session_id:session,model:'configured-model',account:{token:'PRIVATE_INIT_TOKEN'}});
  const text=f.message.content;
  if(text==='hold') return;
  if(text==='background'){send({type:'system',subtype:'task_started',task_id:'task'});finish('working');setTimeout(()=>{send({type:'system',subtype:'task_notification',task_id:'task',status:'completed'});finish('background done')},150);return}
  if(text==='permission'||text==='question') {send({type:'control_request',request_id:'tool-request',request:{subtype:'can_use_tool',tool_name:text==='question'?'AskUserQuestion':'Bash',tool_use_id:'tool-id',input:text==='question'?{questions:[{question:'Which color?',options:[{label:'Blue'}]}]}:{command:'echo approved'}}});return}
  finish(resumeIndex<0?'read '+readFileSync('note.txt','utf8'):'resumed '+session);
 }
 if(f.type==='control_response'){writeFileSync('permission.json',JSON.stringify(f.response.response));finish(f.response.response.allowed?'allowed':'denied')}
});input.on('close',()=>process.exit(0));`

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-codebuddy-")); roots.push(root)
  const cwd = path.join(root, "workspace with spaces"), bin = path.join(root, "public CLI")
  await mkdir(cwd); await mkdir(bin)
  await writeFile(path.join(cwd, "note.txt"), "workspace fixture")
  const script = path.join(bin, "cli.mjs"), launcher = path.join(bin, process.platform === "win32" ? "codebuddy.cmd" : "codebuddy")
  await writeFile(script, fakeCli)
  await writeFile(launcher, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`)
  await chmod(launcher, 0o755)
  const environment = { ComSpec: process.env.ComSpec, WINDIR: process.env.WINDIR, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, USERPROFILE: root, HOME: root, CODEBUDDY_EXECUTABLE: launcher }
  const manager = new ProviderAddons(root, () => environment); await manager.initialize()
  const bundle = await buildCodeBuddyAddon(); bundle.manifest.targets = [`${process.platform}-${process.arch}`]
  await manager.install(bundle)
  return { root, cwd, launcher, environment, manager }
}
const args = (cwd: string, content = "hello", sessionToken: string | null = null, onToolRequest: (request: HarnessToolRequest) => Promise<unknown> = async () => ({ discarded: true })) => ({ cwd, content, sessionToken, model: "default", effort: "default", permissionMode: "request", onToolRequest })
async function collect(manager: ProviderAddons, input: ReturnType<typeof args>) {
  const turn = await manager.startTurn("codebuddy", input), events: HarnessEvent[] = []
  try { for await (const e of turn.stream) events.push(e) } finally { await turn.close() }
  return events
}

test("CodeBuddy discovery chooses public launchers; explicit missing selection never falls back", async () => {
  expect(codeBuddyCandidates({ CODEBUDDY_EXECUTABLE: "chosen.cmd" }, "win32")).toEqual(["chosen.cmd"])
  const candidates = codeBuddyCandidates({ USERPROFILE: "C:\\Users\\example", PATH: "" }, "win32")
  expect(candidates).toContain("C:\\Users\\example\\AppData\\Roaming\\npm\\codebuddy.cmd")
  expect(candidates.some(p => p.includes("WorkBuddy"))).toBe(false)
  await expect(discoverCodeBuddy({ CODEBUDDY_EXECUTABLE: path.join(tmpdir(), "nonexistent-codebuddy-cli") })).rejects.toThrow("selected CodeBuddy CLI is missing")
  const launch = codeBuddyCommand("C:\\example's folder\\codebuddy.cmd", ["$(secret); `evil`"], {}, "win32")
  expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toContain("'C:\\example''s folder\\codebuddy.cmd' '$(secret); `evil`'")
})

test("CodeBuddy keeps CLI model/config defaults and only bypasses permissions on explicit full access", () => {
  const normal = codeBuddyArgs({ cwd: "/work", content: "hi", model: "default", sessionToken: null, permissionMode: "request" })
  expect(() => codeBuddyArgs({ cwd: "/work", content: "hi", model: "default", sessionToken: "session&whoami", permissionMode: "request" })).toThrow("Invalid CodeBuddy session")
  expect(normal).toContain("user,project,local"); expect(normal).not.toContain("--model"); expect(normal).not.toContain("bypassPermissions")
  expect(codeBuddyArgs({ cwd: "/work", content: "hi", model: "custom", effort: "high", sessionToken: "session", permissionMode: "full" })).toEqual([...normal.slice(0, -1), "bypassPermissions", "--model", "custom", "--effort", "high", "--resume", "session"])
  expect(codeBuddyTranscript({ type: "system", subtype: "init", account: { token: "private" } })).toEqual([])
  expect(codeBuddyTranscript({ type: "assistant", message: { content: [{ type: "thinking", text: "private" }, { type: "text", text: "visible" }, { type: "tool_use", id: "read", name: "Read", input: { file_path: "note.txt" } }] } })).toMatchObject([{ kind: "assistant_text", text: "visible" }, { kind: "tool_call", tool: { toolId: "read" } }])
})

test("packaged CodeBuddy runs at the selected workspace, resumes, and coexists with DeepSeek across registry restarts", async () => {
  const f = await fixture()
  const deepseek = await buildDeepSeekAddon(); deepseek.manifest.targets = [`${process.platform}-${process.arch}`]; await f.manager.install(deepseek)
  expect(await f.manager.status("codebuddy", true)).toMatchObject({ state: "ready" })
  const events = await collect(f.manager, args(f.cwd))
  expect(events.some(e => e.entry?.kind === "assistant_text" && e.entry.text === "read workspace fixture")).toBe(true)
  expect(JSON.stringify(events)).not.toContain("PRIVATE_INIT_TOKEN")
  expect(JSON.parse(await readFile(path.join(f.cwd, "cli-start.json"), "utf8")).cwd).toBe(f.cwd)
  await f.manager.change("deepseek", "disable")
  expect(f.manager.providers().map(p => p.id)).toEqual(["codebuddy"])
  const restarted = new ProviderAddons(f.root, () => f.environment); await restarted.initialize()
  const resumed = await collect(restarted, args(f.cwd, "hello", "fixture-session"))
  expect(resumed.some(e => e.entry?.kind === "assistant_text" && e.entry.text === "resumed fixture-session")).toBe(true)
  await restarted.change("codebuddy", "uninstall"); await restarted.change("deepseek", "enable")
  const url = new URL("http://localhost:3218/api/providers")
  const catalog = await handleProviderAddons(new Request(url), url, restarted, true)
  expect((await catalog!.json()).providers.map((p: any) => p.id)).toEqual(["claude", "codex", "deepseek"])
}, 45_000)

test("packaged CodeBuddy permission denial, explicit approval and question answers round trip", async () => {
  const f = await fixture()
  for (const [content, answer, allowed] of [
    ["permission", { discarded: true }, false], ["permission", { answers: { decision: ["Reject"] } }, false],
    ["permission", { answers: { decision: ["Allow once"] } }, true], ["question", { answers: { "0": ["Blue"] } }, true],
  ] as const) {
    const events = await collect(f.manager, args(f.cwd, content, null, async () => answer))
    expect(events.some(e => e.entry?.kind === "tool_call" && e.entry.tool.toolKind === "ask_user_question")).toBe(true)
    const response = JSON.parse(await readFile(path.join(f.cwd, "permission.json"), "utf8"))
    expect(response.allowed).toBe(allowed)
    if (content === "question") expect(response.updatedInput.answers).toEqual({ "Which color?": "Blue" })
  }
}, 45_000)

test("CodeBuddy waits for background work and Stop confirms process exit before unlocking the add-on", async () => {
  const f = await fixture()
  const events = await collect(f.manager, args(f.cwd, "background"))
  expect(events.at(-1)?.entry).toMatchObject({ kind: "result", result: "background done" })
  const turn = await f.manager.startTurn("codebuddy", args(f.cwd, "hold")), stream = turn.stream[Symbol.asyncIterator]()
  await stream.next()
  await expect(f.manager.change("codebuddy", "disable")).rejects.toThrow("Wait for")
  await turn.interrupt(); await stream.return?.()
  expect(await readFile(path.join(f.cwd, "interrupted"), "utf8")).toBe("yes")
  expect(f.manager.snapshot().find(p => p.id === "codebuddy")?.busy).toBe(false)
  await f.manager.change("codebuddy", "disable")
}, 30_000)

test("Stop during CodeBuddy discovery prevents late process startup", async () => {
  let release!: () => void, spawned = false
  const ready = new Promise<void>(resolve => { release = resolve })
  const turn = startCodeBuddyTurn({ ...args("/work"), permissionMode: "request", environment: {} }, {
    check: async () => { await ready; return { executable: "unused", version: "2.180.0" } },
    spawn: () => { spawned = true; throw new Error("unexpected spawn") },
  })
  const stream = turn.stream[Symbol.asyncIterator](), pending = stream.next()
  await turn.interrupt(); release(); expect((await pending).done).toBe(true); expect(spawned).toBe(false)
})

test("coordinator preserves CodeBuddy history and session identity through uninstall, restart and reinstall", async () => {
  const f = await fixture()
  let store = new EventStore(f.root); await store.initialize()
  const project = await store.openProject(f.cwd, "Fixture workspace"), chat = await store.createChat(project.id)
  await store.renameChat(chat.id, "CodeBuddy fixture")
  const coordinator = () => new AgentCoordinator({ store, addons: f.manager, onStateChange() {},
    generateTitle: async () => ({ title: "CodeBuddy fixture", usedFallback: false, failureMessage: null }) })
  let agent = coordinator()
  const send = () => agent.send({ type: "chat.send", chatId: chat.id, provider: "codebuddy", content: "hello", model: "default", modelOptions: { codebuddy: { reasoningEffort: "default" } }, permissionMode: "request" })
  const settle = async () => {
    const deadline = Date.now() + 15_000
    while (agent.getActiveStatuses().has(chat.id) || agent.getDrainingChatIds().has(chat.id)) {
      if (Date.now() > deadline) throw new Error("Fixture coordinator did not settle")
      await Bun.sleep(20)
    }
  }
  try {
    await send(); await settle()
    expect(store.requireChat(chat.id)).toMatchObject({ provider: "codebuddy", sessionToken: "fixture-session", lastTurnPreferences: { provider: "codebuddy", model: "default" } })
    await f.manager.change("codebuddy", "uninstall")
    await expect(send()).rejects.toThrow("Settings → Integrations")
    await agent.shutdown(); await store.compact()
    store = new EventStore(f.root); await store.initialize(); agent = coordinator()
    expect(store.requireChat(chat.id).provider).toBe("codebuddy")
    const bundle = await buildCodeBuddyAddon(); bundle.manifest.targets = [`${process.platform}-${process.arch}`]; await f.manager.install(bundle)
    await send(); await settle()
    const entries = []; for await (const e of store.iterateMessages(chat.id)) entries.push(e)
    expect(entries.some(e => e.kind === "assistant_text" && e.text === "read workspace fixture")).toBe(true)
    expect(entries.some(e => e.kind === "assistant_text" && e.text === "resumed fixture-session")).toBe(true)
    expect(store.requireChat(chat.id).sessionToken).toBe("fixture-session")
  } finally { await agent.shutdown() }
}, 45_000)
