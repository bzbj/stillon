import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { ProviderAddons } from "../src/server/provider-addons"
import { AgentCoordinator } from "../src/server/agent"
import { EventStore } from "../src/server/event-store"
import type { HarnessEvent } from "../src/server/harness-types"
import { buildBundledIntegrations } from "./build-integrations"
import { createMacIntegrationCliFixture } from "./macos-integration-fixture"

if (!process.argv.includes("--run") || process.platform !== "darwin") throw new Error("Pass --run on macOS with the pinned public CLIs installed in test-artifacts/macos-cli.")
const root = path.resolve("test-artifacts/macos-integrations", crypto.randomUUID())
await mkdir(root, { recursive: true })
const fixture = await createMacIntegrationCliFixture(root), data = path.join(root, "data"), bundles = path.join(root, "bundled")
try {
  await buildBundledIntegrations(bundles)
  let manager = new ProviderAddons(data, () => fixture.environment); await manager.initialize(bundles)
  assert(manager.snapshot().every(addon => addon.compatible && !addon.enabled))
  await fixture.configure(manager)
  for (const provider of ["deepseek", "codebuddy"] as const) {
    let token: string | null = null
    const model = provider === "deepseek" ? manager.providers().find(item => item.id === provider)!.defaultModel : "default"
    for (const marker of ["MAC_TEXT", "MAC_RESUME", "MAC_READ", "MAC_QUESTION", "MAC_HOLD"]) {
      let questions = 0
      const turn = await manager.startTurn(provider, { cwd: fixture.workspace, content: marker, model, sessionToken: token, permissionMode: "request",
        onToolRequest: async request => {
          questions++
          assert.equal(request.tool.toolKind, "ask_user_question")
          if (request.tool.toolKind !== "ask_user_question") return { discarded: true }
          return { answers: Object.fromEntries(request.tool.input.questions.map(question => [question.id ?? question.question, ["Blue"]])) }
        } })
      const events: HarnessEvent[] = []
      const timer = setTimeout(() => { void turn.interrupt() }, 120_000)
      let stopping: Promise<void> | undefined
      const poll = marker === "MAC_HOLD" ? setInterval(() => {
        if (!stopping && fixture.requests.some(request => request.marker === marker)) stopping = turn.interrupt()
      }, 50) : undefined
      try { for await (const event of turn.stream) events.push(event) }
      finally { clearTimeout(timer); clearInterval(poll); await stopping; await turn.close() }
      assert.deepEqual(fixture.errors, [])
      if (marker === "MAC_HOLD") {
        assert(stopping, "Stop must interrupt an actual in-flight model request")
        assert.equal(manager.snapshot().find(addon => addon.id === provider)?.busy, false)
        await manager.change(provider, "disable"); await manager.change(provider, "enable")
      } else {
        assert(events.some(event => event.entry?.kind === "result" && !event.entry.isError && event.entry.result === `${marker}_OK`), JSON.stringify(events))
        const session = events.find(event => event.type === "session_token")?.sessionToken
        assert(session, "real CLI session identity is required")
        if (token) assert.equal(session, token)
        token = session!
        if (marker === "MAC_QUESTION") assert.equal(questions, 1)
      }
      manager = new ProviderAddons(data, () => fixture.environment); await manager.initialize(bundles)
      console.log(`PASS ${process.arch}: ${provider} ${marker}, bundled adapter and real public CLI`)
    }
    fixture.requests.length = 0
  }
  const store = new EventStore(data); await store.initialize()
  const project = await store.openProject(fixture.workspace, "Mac integration acceptance")
  const agent = new AgentCoordinator({ store, addons: manager, onStateChange() {},
    generateTitle: async () => ({ title: "Mac integration acceptance", usedFallback: false, failureMessage: null }) })
  try {
    for (const provider of ["deepseek", "codebuddy"] as const) {
      const chat = await store.createChat(project.id), answered = new Set<string>()
      for (const marker of ["MAC_TEXT", "MAC_QUESTION"]) {
        await agent.send({ type: "chat.send", chatId: chat.id, provider, content: marker, permissionMode: "request" })
        const deadline = Date.now() + 120_000
        while (agent.getActiveStatuses().has(chat.id) || agent.getDrainingChatIds().has(chat.id)) {
          assert(Date.now() < deadline, "coordinator must finish the real CLI question")
          for await (const event of store.iterateMessages(chat.id)) {
            if (event.kind !== "tool_call" || event.tool.toolKind !== "ask_user_question" || answered.has(event.tool.toolId)) continue
            answered.add(event.tool.toolId)
            await agent.respondTool({ type: "chat.respondTool", chatId: chat.id, toolUseId: event.tool.toolId,
              result: { answers: Object.fromEntries(event.tool.input.questions.map(question => [question.id ?? question.question, ["Blue"]])) } })
          }
          await Bun.sleep(50)
        }
      }
      const page = await store.getRecentChatHistory(chat.id, 40)
      assert.equal(answered.size, 1)
      assert.equal(page.messages.filter(event => event.kind === "result" && !event.isError).length, 2, "question results must not truncate the persisted transcript")
      assert(page.messages.some(event => event.kind === "assistant_text" && event.text === "MAC_TEXT_OK"))
      assert(page.messages.some(event => event.kind === "assistant_text" && event.text === "MAC_QUESTION_OK"))
      assert.deepEqual(fixture.errors, [])
      console.log(`PASS ${process.arch}: ${provider} coordinator questions preserve paginated chat history`)
    }
  } finally { await agent.shutdown() }
} finally { fixture.stop(); await rm(root, { recursive: true, force: true }) }
