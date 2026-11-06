// Regenerate golden states with the pinned, unmodified upstream installation.
// bun scripts/generate-dsh-statistics-fixtures.ts /path/to/node_modules/@deepseek-ai
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import provenance from "../src/shared/vendor/dsh/provenance.json"
const root = process.argv[2]
if (!root) throw new Error("Provide the pinned upstream @deepseek-ai directory")
for (const [name, source] of Object.entries(provenance)) {
  const bytes = await Bun.file(path.join(root, name, source.source)).arrayBuffer()
  if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== source.sha256) throw new Error(`Unexpected upstream ${name}`)
}
const { sessionStatsProjectionDefinition: stats } = await import(pathToFileURL(path.join(root, "dsh-session-stats/lib/types/projection.js")).href)
const { tokenUsageProjectionDefinition: usage } = await import(pathToFileURL(path.join(root, "dsh-token-meter/lib/types/usage-projection.js")).href)
const e = (type: string, time: number, data: any = {}) => ({ type, time, data: { turn: 1, step: 1, ...data } })
const u = (inputTokens = 10, outputTokens = 4) => ({ inputTokens, outputTokens, cacheReadTokens: 3, cacheWriteTokens: 2 })
const c = (time: number, chunk: any) => ({ type: "chunk", time, chunk })
const cases = [
  { name: "weighted multi-step and overlapping tools", events: [
    e("step/start", 100), e("assistant/message", 900, { usage: u(), stream: [c(300, { type: "text-delta", text: "a" })] }), e("step/end", 900),
    e("tool/call", 910, { callId: "a" }), e("tool/call", 920, { callId: "b" }),
    e("tool/result", 1200, { message: { source: { callId: "a" } } }), e("tool/result", 1300, { message: { source: { callId: "b" } } }),
    e("step/start", 1300, { step: 2 }), e("assistant/message", 1900, { step: 2, usage: u(20, 12), stream: [c(1500, { type: "reasoning-delta", text: "think" })] }), e("step/end", 1900, { step: 2 }), e("turn/end", 1900),
  ] },
  { name: "attempt replacement, retry billing and surviving first token", events: [
    e("step/start", 100), e("assistant/attempt", 400, { stream: [c(200, { type: "text-delta", text: "x" }), c(400, { type: "usage", usage: u() })] }),
    e("assistant/attempt", 410, { stream: [c(410, { type: "usage", usage: u(11, 5) })] }), e("llm/retry-started", 420),
    e("assistant/message", 700, { usage: u(30, 6), stream: [c(600, { type: "text-delta", text: "second" })] }),
    e("assistant/message", 710, { usage: u(30, 6), stream: [] }), e("step/end", 720), e("turn/end", 720),
  ] },
  { name: "packed stream, empty deltas and named tool first token", events: [
    e("step/start", 100), e("assistant/message", 500, { usage: u(), stream: [c(110, { type: "text-delta", text: "" }), { type: "text-chunks", time0: 120, texts: ["", "a"], dt: [80] }] }), e("step/end", 500),
    e("step/start", 600, { step: 2 }), e("assistant/message", 800, { step: 2, usage: u(), stream: [{ type: "tool-call-chunks", time0: 620, name: "read", args: [""], dt: [] }] }), e("step/end", 800, { step: 2 }),
  ] },
  { name: "cancelled, unmatched prototype call and cleared pending state", events: [
    e("step/start", 100), e("assistant/attempt", 200, { stream: [c(150, { type: "reasoning-delta", text: "x" })] }),
    e("tool/result", 210, { message: { source: { callId: "constructor" } } }), e("tool/call", 220, { callId: "constructor" }),
    e("tool/result", 230, { message: { source: { callId: "constructor" } } }), e("tool/call", 240, { callId: "unresolved" }), e("step/end", 250), e("turn/end", 250),
  ] },
  { name: "zero and one millisecond decode windows stay unfiltered", events: [
    e("step/start", 100), e("assistant/message", 110, { usage: u(), stream: [c(110, { type: "text-delta", text: "x" })] }), e("step/end", 110),
    e("step/start", 120, { turn: 2 }), e("assistant/message", 131, { turn: 2, usage: u(10, 100), stream: [c(130, { type: "text-delta", text: "x" })] }), e("step/end", 131, { turn: 2 }),
  ] },
]
const fixtures = cases.map(item => {
  let s = stats.init(), t = usage.init()
  return { ...item, states: item.events.map(event => { s = stats.apply(s, event); t = usage.apply(t, event); return { stats: s, usage: t } }) }
})
await Bun.write("src/shared/vendor/dsh/fixtures/upstream.json", JSON.stringify(fixtures, null, 2) + "\n")
