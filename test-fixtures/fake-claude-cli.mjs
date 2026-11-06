// Minimal stream-json Claude Code CLI used to test what the SDK asks the CLI to
// put on the wire. It records its argv and every frame it writes to the file named
// by STILLON_FAKE_CLAUDE_LOG (one JSON line each, tagged with its pid), and, like the real CLI, writes `stream_event` frames
// only when `--include-partial-messages` was passed at spawn time.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const logPath = process.env.STILLON_FAKE_CLAUDE_LOG
const partial = process.argv.includes("--include-partial-messages")
const sessionId = "fake-claude-session"
const log = (entry) => logPath && appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const write = (frame) => {
  log({ wrote: frame.type, ...(frame.event ? { event: frame.event.type } : {}) })
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, uuid: crypto.randomUUID(), parent_tool_use_id: null, ...frame })}\n`)
}
log({ spawned: true, partial })

const usage = (output) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const waiting = new Map()
let initialized = false
let nextMessage = 0

function streamStep(id, text, output) {
  if (!partial) return
  write({ type: "stream_event", event: { type: "message_start", message: { id, usage: usage(0) } } })
  write({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } })
  for (const piece of text.match(/.{1,4}/g) ?? [text]) {
    write({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } })
  }
  write({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })
  write({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } })
  write({ type: "stream_event", event: { type: "message_stop" } })
}

async function turn(prompt) {
  const id = `msg-${++nextMessage}`
  if (!initialized) {
    initialized = true
    write({ type: "system", subtype: "init", model: "fake", tools: ["Read"], agents: [], slash_commands: [], mcp_servers: [] })
  }
  if (prompt.includes("ask")) {
    const requestId = `ask-${id}`
    const answered = new Promise((resolve) => waiting.set(requestId, resolve))
    write({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: `tool-${id}`, input: { questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }], multiSelect: false }] } } })
    log({ answer: await answered })
  }
  if (prompt.includes("tool")) {
    streamStep(`${id}-a`, "Reading", 5)
    write({ type: "assistant", message: { id: `${id}-a`, role: "assistant", content: [{ type: "tool_use", id: `tool-${id}`, name: "Read", input: { file_path: "/tmp/example" } }], usage: usage(5) } })
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "ok" }] } })
  }
  streamStep(id, "Hello from fake", 7)
  write({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text: "Hello from fake" }], usage: usage(7) } })
  write({ type: "result", subtype: "success", is_error: false, duration_ms: 1, result: "Hello from fake", usage: usage(7), modelUsage: {} })
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.type === "control_request") {
    log({ control: frame.request.subtype })
    const response = frame.request.subtype === "initialize"
      ? { commands: [], output_style: "default", available_output_styles: [], models: [], account: { email: "fake@example.com" } }
      : {}
    process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response } })}\n`)
  } else if (frame.type === "control_response") {
    waiting.get(frame.response.request_id)?.(frame.response.response)
  } else if (frame.type === "user") {
    const content = frame.message.content
    void turn(typeof content === "string" ? content : JSON.stringify(content))
  }
})
process.stdin.on("end", () => process.exit(0))
