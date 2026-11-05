import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { DeepSeekRpc, deepSeekTranscript, startDeepSeekTurn } from "../../addons/deepseek/src/deepseek-harness"
import { deepSeekCandidates, deepSeekCommand } from "../../addons/deepseek/src/deepseek-cli"
import type { HarnessEvent } from "./harness-types"
import { harnessModelId, harnessModelRoute } from "../shared/harness-models"

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  requests: any[] = []
  handler: (frame: any) => void = () => {}
  constructor() {
    super()
    let buffer = ""
    this.stdin.on("data", chunk => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        this.requests.push(frame)
        if (frame.method === "shutdown") { this.reply(frame, {}); queueMicrotask(() => this.emit("close", 0)); continue }
        this.handler(frame)
      }
    })
  }
  send(frame: any) { this.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n") }
  reply(frame: any, result: any) { this.send({ id: frame.id, result }) }
  asChild() { return this as unknown as ChildProcessWithoutNullStreams }
}

describe("DeepSeek public CLI", () => {
  test("provider-qualified model IDs preserve gateway punctuation and legacy routes", () => {
    expect(harnessModelRoute(harnessModelId("my-gateway", "org/model:variant"))).toEqual({ provider: "my-gateway", model: "org/model:variant" })
    expect(harnessModelRoute("deepseek-flash")).toEqual({ provider: "deepseek-official", model: "deepseek-flash" })
    expect(harnessModelId("account", "same")).not.toBe(harnessModelId("api", "same"))
    expect(() => harnessModelRoute("dsh:broken")).toThrow()
  })
  test("quotes Windows paths and arguments as literals, without evaluating shell syntax", () => {
    const command = deepSeekCommand("C:\\Users\\example\\My 'Harness\\dsh.cmd", ["--profile", "sdk", "$(bad); `bad`"], { SystemRoot: "C:\\Windows" }, "win32")
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("& 'C:\\Users\\example\\My ''Harness\\dsh.cmd' '--profile' 'sdk' '$(bad); `bad`'")
    expect(command.command).toContain("WindowsPowerShell")
    expect(deepSeekCommand("/opt/dsh", ["--profile", "sdk"], {}, "linux")).toEqual({ command: "/opt/dsh", args: ["--profile", "sdk"] })
  })
  test("explicit launcher fails closed, while standard desktop locations need no PATH entry", () => {
    expect(deepSeekCandidates({ DSH_EXECUTABLE: "chosen.cmd" }, "win32")).toEqual(["chosen.cmd"])
    expect(deepSeekCandidates({ USERPROFILE: "C:\\Users\\example", PATH: "" }, "win32")).toContain("C:\\Users\\example\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd")
    expect(deepSeekCandidates({ HOME: "/Users/example", PATH: "" }, "darwin")).toContain("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")
  })
})

describe("DeepSeek protocol boundary", () => {
  test("native question results do not orphan the coordinator's question history", () => {
    const questions = new Set<string>()
    expect(deepSeekTranscript({ type: "tool/call", data: { name: "ask_user_question", callId: "native-question" } }, questions)).toEqual([])
    expect(deepSeekTranscript({ type: "tool/result", data: { message: { toolCallId: "native-question", content: "Blue" } } }, questions)).toEqual([])
    expect(deepSeekTranscript({ type: "tool/result", data: { message: { toolCallId: "file-read", content: "file text" } } }, questions)).toMatchObject([{ kind: "tool_result", toolId: "file-read", content: "file text" }])
  })
  test("correlates concurrent responses and reads split UTF-8 frames", async () => {
    const child = new FakeProcess(), rpc = new DeepSeekRpc(child.asChild())
    const a = rpc.request("first"), b = rpc.request("second")
    const frame = Buffer.from(JSON.stringify({ id: 2, result: "你好" }) + "\n")
    const split = frame.indexOf(Buffer.from("你")) + 1
    child.stdout.write(frame.subarray(0, split)); child.stdout.write(frame.subarray(split))
    child.send({ id: 1, result: "first" })
    expect(await b).toBe("你好"); expect(await a).toBe("first")
    await rpc.close()
  })
  test("process loss rejects requests and malformed stdout never becomes transcript", async () => {
    const child = new FakeProcess(), rpc = new DeepSeekRpc(child.asChild())
    const pending = rpc.request("initialize")
    child.stdout.write("not json\n")
    await expect(pending).rejects.toThrow("invalid JSON")
    child.emit("close", 1)
    await rpc.close()
  })
  test("only projects visible messages, parsed tool arguments and matching results", () => {
    expect(deepSeekTranscript({ type: "request/header", data: { credential: "private" } })).toEqual([])
    expect(deepSeekTranscript({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "private" }, { type: "text", text: "answer" }] } } })[0]).toMatchObject({ kind: "assistant_text", text: "answer" })
    expect(deepSeekTranscript({ type: "tool/call", data: { name: "pwsh", callId: "tool-1", arguments: '{"command":"Get-Date"}' } })[0]).toMatchObject({ kind: "tool_call", tool: { toolId: "tool-1", input: { command: "Get-Date" } } })
    expect(deepSeekTranscript({ type: "tool/result", data: { message: { toolCallId: "tool-1", content: [{ type: "text", text: "ok" }] } } })[0]).toMatchObject({ kind: "tool_result", toolId: "tool-1", content: "ok" })
  })
})

test("turn uses official API, resumes, sets boot permissions and ignores idle before its receipt", async () => {
  const child = new FakeProcess()
  let environment: NodeJS.ProcessEnv = {}
  child.handler = frame => {
    if (frame.method === "initialize") child.reply(frame, { serverInfo: { name: "deepseek-harness-sdk-runtime" } })
    if (frame.method === "session/resume") child.reply(frame, {})
    if (frame.method === "session/prompt") {
      const sessionId = frame.params.sessionId
      child.send({ method: "session.status", params: { sessionId, status: "idle" } })
      child.send({ method: "session.event", params: { sessionId: "unrelated", event: { type: "assistant/message", data: { message: { content: "do not show" } } } } })
      child.send({ method: "session.event", params: { sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: "message-1" }] } } } })
      child.send({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: "answer" } } } } })
      child.send({ method: "session.event", params: { sessionId, event: { type: "turn/end", data: { reason: { kind: "completed" } } } } })
      child.send({ method: "session.status", params: { sessionId, status: "idle" } })
      child.reply(frame, { messageId: "message-1" })
    }
  }
  const turn = startDeepSeekTurn({ cwd: "/workspace", content: "hello", model: "deepseek-flash", effort: "off", sessionToken: "existing-session", permissionMode: "request", environment: { DSH_PERMISSION_MODE: "danger-full-access" }, onToolRequest: async () => null }, {
    discover: async () => "dsh", version: async () => "0.2.1-rc.5", spawn: (_cli, _cwd, env) => { environment = env; return child.asChild() },
  })
  const events: HarnessEvent[] = []
  for await (const event of turn.stream) events.push(event)
  expect(child.requests.find(frame => frame.method === "initialize").params.provider).toBe("deepseek-official")
  expect(child.requests.some(frame => frame.method === "session/resume")).toBe(true)
  expect(environment.DSH_PERMISSION_MODE).toBe("workspace-write")
  expect(events.filter(event => event.entry?.kind === "assistant_text")).toHaveLength(1)
  expect(events.at(-1)?.entry).toMatchObject({ kind: "result", isError: false, result: "answer" })
  expect(child.requests.at(-1).method).toBe("shutdown")
})

test("host questions preserve ids, detail and labels; dismissal never grants approval", async () => {
  for (const approval of [false, true]) {
    const child = new FakeProcess()
    let sessionId = ""
    let captured: any
    child.handler = frame => {
      if (frame.method === "initialize") child.reply(frame, { serverInfo: { name: "deepseek-harness-sdk-runtime" } })
      if (frame.method === "session/prompt") {
        sessionId = frame.params.sessionId
        child.send({ method: "session.event", params: { sessionId, event: { type: "agent/inbox/spliced", data: { inserted: [{ id: "m" }] } } } })
        child.reply(frame, { messageId: "m" })
        child.send({ id: "host-1", method: approval ? "approval/request" : "user-question/ask", params: {
          sessionId, requestId: "question-1", toolName: "pwsh", reason: "Needs permission",
          questions: [{ id: "choose", question: "Choose", detail: "Plan details", options: [{ label: "First" }, { label: "Second" }], multiSelect: true }],
        } })
      }
      if (frame.id === "host-1") {
        captured = frame.result
        child.send({ method: "session.event", params: { sessionId, event: { type: "turn/end", data: { reason: { kind: "completed" } } } } })
        child.send({ method: "session.status", params: { sessionId, status: "idle" } })
      }
    }
    const turn = startDeepSeekTurn({ cwd: "/workspace", content: "hello", model: "deepseek-flash", sessionToken: null, permissionMode: "request", environment: {},
      onToolRequest: async request => {
        if (approval) return { discarded: true, answers: {} }
        expect(request.tool.toolKind).toBe("ask_user_question")
        if (request.tool.toolKind === "ask_user_question") expect(request.tool.input.questions[0]?.question).toContain("Plan details")
        return { answers: { choose: ["Second", "custom reply"] } }
      },
    }, { discover: async () => "dsh", version: async () => "0.2.1", spawn: () => child.asChild() })
    for await (const _event of turn.stream) { /* Drain and release the owned process. */ }
    expect(captured).toEqual(approval ? { outcome: "cancelled" } : { answers: [{ id: "choose", selected: ["Second"], custom: "custom reply" }] })
  }
})
