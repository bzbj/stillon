import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { AgentCoordinator } from "../src/server/agent"
import { EventStore } from "../src/server/event-store"
import { ProviderAddons } from "../src/server/provider-addons"
import { buildDeepSeekAddon } from "./build-provider-addon"
import type { TranscriptEntry } from "../src/shared/types"

// Opt-in: consumes the locally configured deepseek-official API usage.
if (!process.argv.includes("--run")) throw new Error("Pass --run to use the local DeepSeek API configuration.")
const root = path.resolve("test-artifacts", "deepseek-live", crypto.randomUUID())
const workspace = path.join(root, "workspace")
await mkdir(workspace, { recursive: true })
const challenge = `challenge-${crypto.randomUUID()}`
await writeFile(path.join(workspace, "challenge.txt"), challenge)
let store = new EventStore(path.join(root, "data"))
await store.initialize()
const addons = new ProviderAddons(store.dataDir)
await addons.initialize()
await addons.install(await buildDeepSeekAddon())
const project = await store.openProject(workspace, "DeepSeek acceptance")
const chat = await store.createChat(project.id)
await store.renameChat(chat.id, "DeepSeek acceptance")
const coordinator = () => new AgentCoordinator({ store, addons, onStateChange() {},
  generateTitle: async () => ({ title: "DeepSeek acceptance", usedFallback: false, failureMessage: null }) })
let agent = coordinator()
const messages = async () => { const entries: TranscriptEntry[] = []; for await (const entry of store.iterateMessages(chat.id)) entries.push(entry); return entries }
async function settled() {
  const deadline = Date.now() + 180_000
  while (agent.getActiveStatuses().has(chat.id) || agent.getDrainingChatIds().has(chat.id)) {
    if (Date.now() > deadline) throw new Error("DeepSeek acceptance timed out")
    if (agent.getPendingTool(chat.id)) throw new Error("Unexpected approval during read-only acceptance")
    await Bun.sleep(100)
  }
}
const send = (content: string) => agent.send({ type: "chat.send", chatId: chat.id, content, provider: "deepseek", model: "deepseek-flash", modelOptions: { deepseek: { reasoningEffort: "off" } }, permissionMode: "request" })
try {
  await send("Read challenge.txt with a tool. Reply with its exact contents only. Do not change files.")
  await settled()
  let entries = await messages()
  const result = [...entries].reverse().find(entry => entry.kind === "result")
  if (result?.kind === "result" && result.isError) throw new Error(result.result)
  assert(entries.some(entry => entry.kind === "assistant_text" && entry.text.includes(challenge)), "model must read the unseen challenge")
  assert(entries.some(entry => entry.kind === "tool_call"), "tool call must be visible")
  assert(entries.some(entry => entry.kind === "tool_result"), "tool result must be visible")
  const token = store.requireChat(chat.id).sessionToken
  assert(token)
  console.log("PASS local coordinator: API inference, file read, transcript, durable token")
  await agent.shutdown()
  store = new EventStore(path.join(root, "data"))
  await store.initialize()
  agent = coordinator()
  assert.equal(store.requireChat(chat.id).provider, "deepseek")
  const before = (await messages()).length
  await send("Without any tools, repeat the exact challenge you just read. Reply with it only.")
  await settled()
  entries = (await messages()).slice(before)
  assert(entries.some(entry => entry.kind === "assistant_text" && entry.text.includes(challenge)), "resume must recall the challenge")
  assert.equal(store.requireChat(chat.id).sessionToken, token)
  assert(!entries.some(entry => entry.kind === "tool_call"))
  console.log("PASS coordinator restart: persistent chat, resume, no tool re-read")
  await send("Use pwsh to run Start-Sleep -Seconds 45; then reply done. Do not read or change any files.")
  const deadline = Date.now() + 60_000
  while (!(await messages()).some(entry => entry.kind === "tool_call" && entry.tool.toolName === "Bash" && JSON.stringify(entry.tool.input).includes("Start-Sleep"))) {
    if (Date.now() > deadline || !agent.getActiveStatuses().has(chat.id)) throw new Error("Stop exercise did not reach the sleep tool")
    await Bun.sleep(100)
  }
  await agent.cancel(chat.id)
  await settled()
  console.log("PASS Stop: coordinator confirmed process exit")
  await writeFile(path.join(root, "report.json"), JSON.stringify({ provider: "deepseek-official", model: "deepseek-flash", read: true, restartResume: true, stop: true, chatId: chat.id }, null, 2))
  console.log("Report:", path.join(root, "report.json"))
} finally { await agent.shutdown() }
