/** Browser replay of the real decoder and transcript processor, excluding fetch time and React rendering. */
import { ChatStreamDecoder } from "../src/shared/chat-stream"
import { createTranscriptProcessor, processTranscriptMessages } from "../src/client/lib/parseTranscript"
import type { ChatSnapshot, TranscriptEntry } from "../src/shared/types"

async function replay(mode: "snapshot" | "delta") {
  const fixture: { frames: string[]; older: TranscriptEntry[] } = await (await fetch(`/fixtures/${mode}.json`)).json()
  const decoder = new ChatStreamDecoder("benchmark-stream")
  const processMessages = mode === "delta" ? createTranscriptProcessor() : processTranscriptMessages
  const costs: number[] = []
  let previous: ChatSnapshot | null = null
  let hydrated = 0
  let lastOutput = new Map<string, unknown>()
  let finalIds: string[] = []
  for (const raw of fixture.frames) {
    if (costs.length % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const started = performance.now()
    const frame = JSON.parse(raw)
    let snapshot: ChatSnapshot = frame.snapshot?.data
    if (mode === "delta") {
      const result = decoder.receive(frame.type === "snapshot" ? { type: "snapshot", stream: frame.stream, data: snapshot } : frame)
      if (result.kind !== "apply" || !result.snapshot) throw new Error("Invalid browser stream")
      snapshot = result.snapshot
    }
    if (snapshot.messages !== previous?.messages) {
      const output = processMessages([...fixture.older, ...snapshot.messages])
      hydrated += output.filter((message) => lastOutput.get(message.id) !== message).length
      lastOutput = new Map(output.map((message) => [message.id, message]))
    }
    previous = snapshot
    finalIds = snapshot.messages.map((entry) => entry._id)
    costs.push(performance.now() - started)
  }
  const sorted = [...costs].sort((a, b) => a - b)
  return { mode, frames: costs.length, processingMs: costs.reduce((a, b) => a + b, 0),
    frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], frameMaxMs: sorted.at(-1),
    framesOver50Ms: costs.filter((ms) => ms > 50).length, hydratedObjects: hydrated, finalIds }
}
const button = document.querySelector<HTMLButtonElement>("button")!
button.onclick = async () => {
  button.disabled = true
  const output = document.querySelector("pre")!
  output.textContent = "Running…"
  try {
    const results = []
    for (const mode of ["snapshot", "delta", "delta", "snapshot"] as const) results.push(await replay(mode))
    output.textContent = JSON.stringify({ scope: "Browser JSON/decode/transcript processing; excludes fetch, network, React rendering and inference", results }, null, 2)
    output.dataset.complete = "true"
  } catch (error) { output.textContent = String(error); output.dataset.complete = "error" }
  finally { button.disabled = false }
}
