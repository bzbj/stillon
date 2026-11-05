import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { ProviderAddons } from "../src/server/provider-addons"
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
} finally { fixture.stop(); await rm(root, { recursive: true, force: true }) }
