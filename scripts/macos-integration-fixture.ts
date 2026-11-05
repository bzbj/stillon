import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProviderAddons } from "../src/server/provider-addons"
import { harnessModelId } from "../src/shared/harness-models"

// Real, separately installed vendor CLIs; only model HTTP responses are synthetic.
export async function createMacIntegrationCliFixture(root: string, cliDirectory = path.resolve("test-artifacts/macos-cli/node_modules/.bin")) {
  const home = path.join(root, "home"), workspace = path.join(root, "workspace with spaces")
  for (const directory of [home, workspace]) await mkdir(directory, { recursive: true })
  const fileContent = `MAC_FILE_${crypto.randomUUID()}`
  await writeFile(path.join(workspace, "note.txt"), fileContent)
  const secret = `synthetic-${crypto.randomUUID()}`
  const requests: { marker: string; read: boolean; resumed: boolean; answer: boolean }[] = []
  const errors: string[] = []
  let serial = 0
  const held = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async request => {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mac-test", object: "model" }] })
    try {
      assert.equal(request.headers.get("authorization"), `Bearer ${secret}`)
      const body = await request.json() as any, messages = body.messages as any[]
      assert.equal(body.model, "mac-test")
      let user = -1
      messages.forEach((message, index) => { if (message.role === "user" && /MAC_(TEXT|RESUME|READ|QUESTION|HOLD)/u.test(JSON.stringify(message.content))) user = index })
      assert(user >= 0, "request must contain an acceptance marker")
      const marker = JSON.stringify(messages[user].content).match(/MAC_(?:TEXT|RESUME|READ|QUESTION|HOLD)/u)![0]
      const subsequent = messages.slice(user + 1)
      const toolMessages = subsequent.filter(message => message.role === "tool" || (Array.isArray(message.content) && message.content.some((block: any) => block.type === "tool_result")))
      const resultText = JSON.stringify(toolMessages)
      const read = resultText.includes(fileContent), answer = resultText.includes("Blue")
      const resumed = JSON.stringify(messages.slice(0, user)).includes("MAC_TEXT_OK")
      requests.push({ marker, read, resumed, answer })
      if (marker === "MAC_HOLD") return new Response(new ReadableStream<Uint8Array>({
        start(controller) { held.add(controller); controller.enqueue(new TextEncoder().encode(": holding\n\n"));
          request.signal.addEventListener("abort", () => { held.delete(controller); try { controller.close() } catch {} }, { once: true }) },
        cancel() { held.clear() },
      }), { headers: { "Content-Type": "text/event-stream" } })
      let delta: any = { role: "assistant", content: `${marker}_OK` }, finish = "stop"
      const toolResult = toolMessages.length > 0
      if (!toolResult && ["MAC_READ", "MAC_QUESTION"].includes(marker)) {
        const tools = body.tools as any[], question = marker === "MAC_QUESTION"
        const name = tools.find(tool => (question ? /^(ask_user_question|AskUserQuestion)$/u : /^(read|Read)$/u).test(tool.function?.name))?.function.name
        assert(name, "the public CLI must advertise the requested tool")
        const args = question ? { questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "Use blue." }, { label: "Red", description: "Use red." }], multiSelect: false }] }
          : { file_path: path.join(workspace, "note.txt") }
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `mac-tool-${++serial}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
        finish = "tool_calls"
      }
      if (toolResult && marker === "MAC_READ") assert(read, "the real CLI must read the fixture file")
      if (toolResult && marker === "MAC_QUESTION") assert(answer, "the real CLI must receive the host answer")
      if (marker === "MAC_RESUME") assert(resumed, "resume must retain the preceding conversation")
      const frame = { id: `mac-${++serial}`, object: "chat.completion.chunk", model: "mac-test", choices: [{ index: 0, delta, finish_reason: null }] }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify({ ...frame,
        choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unexpected model request")
      return Response.json({ error: { message: "Synthetic endpoint acceptance failed" } }, { status: 400 })
    }
  } })
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, SHELL: "/bin/sh",
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    DSH_HOME: path.join(home, "dsh"), DSH_EXECUTABLE: path.join(cliDirectory, "dsh"),
    CODEBUDDY_CONFIG_DIR: path.join(home, "codebuddy"), CODEBUDDY_EXECUTABLE: path.join(cliDirectory, "codebuddy"),
    CODEBUDDY_API_KEY: secret, CODEBUDDY_BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`, CODEBUDDY_MODEL: "mac-test",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost",
  }
  return { environment, workspace, requests, errors,
    async configure(manager: ProviderAddons) {
      for (const provider of ["deepseek", "codebuddy"] as const) {
        await manager.change(provider, "enable")
        assert.equal((await manager.status(provider, true)).state, "ready", `${provider} must use the real installed CLI`)
      }
      await manager.modelOperation("deepseek", "configure", { provider: "mac-local", revision: "", baseURL: `http://127.0.0.1:${endpoint.port}/v1`,
        api: "openai-completions", apiKey: secret, models: ["mac-test"] })
      await manager.modelOperation("deepseek", "discover", { provider: "mac-local" })
      const id = harnessModelId("mac-local", "mac-test")
      await manager.selectModels("deepseek", { ids: [id], defaultModel: id })
    },
    stop() { for (const controller of held) { try { controller.close() } catch {} }; held.clear(); endpoint.stop(true) },
  }
}
