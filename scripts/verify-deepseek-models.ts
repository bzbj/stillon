import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { ProviderAddons } from "../src/server/provider-addons"
import { buildBundledIntegrations } from "./build-integrations"
import { discoverDeepSeek } from "../addons/deepseek/src/deepseek-cli"
import { harnessModelId } from "../src/shared/harness-models"
import { AgentCoordinator } from "../src/server/agent"
import { EventStore } from "../src/server/event-store"
import type { TranscriptEntry } from "../src/shared/types"

// Opt-in real public CLI, with isolated native credentials and a loopback model endpoint.
if (!process.argv.includes("--run")) throw new Error("Pass --run to test the installed dsh against a local synthetic API.")
const root = path.resolve("test-artifacts/deepseek-models", crypto.randomUUID())
const home = path.join(root, "home"), dsh = path.join(root, "dsh"), workspace = path.join(root, "workspace")
for (const directory of [home, dsh, workspace]) await mkdir(directory, { recursive: true })
const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
  DSH_HOME: dsh, DSH_EXECUTABLE: await discoverDeepSeek(process.env) }
for (const key of Object.keys(environment)) if (/^(DEEPSEEK_|OPENAI_|ANTHROPIC_|STILLON_|CODEX_|CLAUDE_)/iu.test(key)) delete environment[key]
const secret = `synthetic-${crypto.randomUUID()}`
const requests: { model: string; authenticated: boolean; explicitEffort: boolean; workspace: boolean }[] = []
const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "test-model", object: "model" }, { id: "second-model", object: "model" }] })
  const body = await request.json()
  requests.push({ model: body.model, authenticated: request.headers.get("authorization") === `Bearer ${secret}`,
    explicitEffort: "reasoning_effort" in body, workspace: JSON.stringify(body).includes("workspace") })
  const chunks = [
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "BYOK_ROUTE_OK" }, finish_reason: null }] },
    { id: "synthetic", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
} })
try {
  const dataDir = path.join(root, "data"), manager = new ProviderAddons(dataDir, () => environment)
  const bundledDirectory = path.join(root, "runtime/dist/integrations")
  await buildBundledIntegrations(bundledDirectory); await manager.initialize(bundledDirectory)
  assert.deepEqual(manager.providers(), [])
  await manager.change("deepseek", "enable")
  const draft = { provider: "local-test", revision: "", baseURL: `http://127.0.0.1:${endpoint.port}/v1`,
    api: "openai-completions", apiKey: secret, models: ["test-model", "second-model"] }
  const fetched = await manager.modelOperation("deepseek", "fetchModels", draft)
  assert.deepEqual(fetched.map((model: { id: string }) => model.id), draft.models)
  await manager.modelOperation("deepseek", "configure", draft)
  const config = await manager.modelOperation("deepseek", "configuration")
  assert(!JSON.stringify(config).includes(secret), "configuration must never return a key")
  assert(config.services.some((service: { id: string; active: boolean; apiKeyConfigured: boolean }) => service.id === draft.provider && service.active && service.apiKeyConfigured))
  const models = await manager.modelOperation("deepseek", "discover", { provider: draft.provider })
  assert.deepEqual(models.map((model: { model: string }) => model.model), draft.models)
  const id = harnessModelId(draft.provider, "test-model")
  await manager.selectModels("deepseek", { ids: [id], defaultModel: id })
  const restarted = new ProviderAddons(dataDir, () => environment); await restarted.initialize(bundledDirectory)
  assert.equal(restarted.providers()[0]?.defaultModel, id)
  await Bun.write(path.join(workspace, "AGENTS.md"), "Keep replies concise.")
  const store = new EventStore(dataDir); await store.initialize()
  const project = await store.openProject(workspace, "Harness model acceptance"), chat = await store.createChat(project.id)
  const agent = new AgentCoordinator({ store, addons: restarted, onStateChange() {},
    generateTitle: async () => ({ title: "Harness model acceptance", usedFallback: false, failureMessage: null }) })
  const entries: TranscriptEntry[] = []
  try {
    // Omit model/options deliberately: the coordinator must use the saved catalog,
    // not the compatibility models embedded in the immutable package manifest.
    await agent.send({ type: "chat.send", chatId: chat.id, content: "Reply BYOK_ROUTE_OK.", provider: "deepseek", permissionMode: "request" })
    const deadline = Date.now() + 90_000
    while (agent.getActiveStatuses().has(chat.id) || agent.getDrainingChatIds().has(chat.id)) {
      if (Date.now() > deadline) throw new Error("Harness coordinator timed out")
      await Bun.sleep(100)
    }
    for await (const entry of store.iterateMessages(chat.id)) entries.push(entry)
  } finally { await agent.cancel(chat.id) }
  assert(requests.some(request => request.model === "test-model" && request.authenticated && !request.explicitEffort && request.workspace))
  assert(entries.some(entry => entry.kind === "assistant_text" && entry.text.includes("BYOK_ROUTE_OK")))
  const file = path.join(dataDir, "addons/deepseek/models.json"), before = await readFile(file, "utf8")
  await assert.rejects(restarted.modelOperation("deepseek", "configure", { ...draft, revision: "stale", apiKey: "synthetic-rejected-key" }))
  assert.equal(await readFile(file, "utf8"), before)
  console.log("PASS: public CLI configuration, endpoint discovery, native key storage/redaction, exact BYOK routing, model-list reload and stale-write rejection.")
  console.log(`Isolated artifacts: ${root}`)
} finally { endpoint.stop(true) }
