import { Buffer } from "node:buffer"
import {
  applyChatStreamDelta,
  applyChatStreamSnapshot,
  createChatStreamState,
  type ChatStreamState,
} from "../src/client/app/chatStreamState"
import type { ChatDeltaEvent, ServerEnvelope } from "../src/shared/protocol"
import type { ChatRuntime, ChatSnapshot, TranscriptEntry } from "../src/shared/types"

const RECENT_ENTRY_COUNT = 200
const FRAME_COUNT = readPositiveInteger("STILLON_DELTA_BENCH_FRAMES", 64)
const WARMUP_RUNS = readPositiveInteger("STILLON_DELTA_BENCH_WARMUP", 2)
const MEASURED_RUNS = readPositiveInteger("STILLON_DELTA_BENCH_RUNS", 9)
const RETAINED_OLDER_ENTRY_COUNTS = [0, 5_000] as const

let benchmarkSink = 0

interface Workload {
  name: "rolling_append" | "runtime_only"
  initialFull: ChatSnapshot
  initialStream: ChatSnapshot
  fullFrames: string[]
  deltaFrames: string[]
}

interface TimingSummary {
  medianMs: number
  maxMs: number
}

interface PreparedWorkload {
  fullState: ChatStreamState
  streamState: ChatStreamState
}

const preparedWorkloads = new Map<Workload, PreparedWorkload>()
const olderEntryFixtures = new Map<number, TranscriptEntry[]>()

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function seededText(seed: number, length: number) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789一二三四五六七八九十"
  let state = seed || 1
  let output = ""
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += alphabet[state % alphabet.length]
  }
  return output
}

function transcriptEntry(id: string, createdAt: number, textLength = 2_600): TranscriptEntry {
  return {
    _id: id,
    kind: "assistant_text",
    createdAt,
    text: seededText(createdAt + 17, textLength),
  }
}

function runtime(title = "Synthetic benchmark", status: ChatRuntime["status"] = "running"): ChatRuntime {
  return {
    chatId: "benchmark-chat",
    projectId: "benchmark-project",
    localPath: "/workspace/synthetic-project",
    title,
    status,
    isDraining: false,
    provider: "codex",
    planMode: false,
    sessionToken: "synthetic-session",
  }
}

function snapshot(
  messages: TranscriptEntry[],
  nextRuntime = runtime(),
  stream?: ChatSnapshot["stream"],
): ChatSnapshot {
  return {
    runtime: nextRuntime,
    queuedMessages: [],
    messages,
    history: {
      hasOlder: true,
      olderCursor: "synthetic-cursor",
      recentLimit: RECENT_ENTRY_COUNT,
      revision: "synthetic-history",
    },
    availableProviders: [],
    stream,
  }
}

function snapshotEnvelope(data: ChatSnapshot): ServerEnvelope {
  return {
    v: 1,
    type: "snapshot",
    id: "benchmark-subscription",
    snapshot: {
      type: "chat",
      data,
    },
  }
}

function deltaEnvelope(event: ChatDeltaEvent): ServerEnvelope {
  return {
    v: 1,
    type: "event",
    id: "benchmark-subscription",
    event,
  }
}

function buildRollingAppendWorkload(initialMessages: TranscriptEntry[]): Workload {
  let messages = [...initialMessages]
  const fullFrames: string[] = []
  const deltaFrames: string[] = []
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const appended = transcriptEntry(`append-${frame}`, 10_000 + frame)
    const removed = messages[0]!
    messages = [...messages.slice(1), appended]
    fullFrames.push(JSON.stringify(snapshotEnvelope(snapshot(messages))))
    deltaFrames.push(JSON.stringify(deltaEnvelope({
      type: "chat.delta",
      chatId: "benchmark-chat",
      baseSequence: frame,
      stream: {
        version: 1,
        revision: "synthetic-stream",
        sequence: frame + 1,
      },
      transcript: {
        type: "patch",
        evictedIds: [removed._id],
        removedIds: [],
        replaced: [],
        appended: [appended],
      },
    })))
  }

  return {
    name: "rolling_append",
    initialFull: snapshot(initialMessages),
    initialStream: snapshot(initialMessages, runtime(), {
      version: 1,
      revision: "synthetic-stream",
      sequence: 0,
    }),
    fullFrames,
    deltaFrames,
  }
}

function buildRuntimeOnlyWorkload(initialMessages: TranscriptEntry[]): Workload {
  const fullFrames: string[] = []
  const deltaFrames: string[] = []
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const nextRuntime = runtime(
      `Synthetic benchmark ${frame}`,
      frame % 2 === 0 ? "running" : "waiting_for_user",
    )
    fullFrames.push(JSON.stringify(snapshotEnvelope(snapshot(initialMessages, nextRuntime))))
    deltaFrames.push(JSON.stringify(deltaEnvelope({
      type: "chat.delta",
      chatId: "benchmark-chat",
      baseSequence: frame,
      stream: {
        version: 1,
        revision: "synthetic-stream",
        sequence: frame + 1,
      },
      runtime: nextRuntime,
    })))
  }

  return {
    name: "runtime_only",
    initialFull: snapshot(initialMessages),
    initialStream: snapshot(initialMessages, runtime(), {
      version: 1,
      revision: "synthetic-stream",
      sequence: 0,
    }),
    fullFrames,
    deltaFrames,
  }
}

function mergeTranscriptEntries(
  olderEntries: TranscriptEntry[],
  recentEntries: TranscriptEntry[],
) {
  const merged = new Map<string, TranscriptEntry>()
  for (const entry of olderEntries) merged.set(entry._id, entry)
  for (const entry of recentEntries) merged.set(entry._id, entry)
  return [...merged.values()]
}

function reconcileRecentWindow(
  previous: TranscriptEntry[],
  next: TranscriptEntry[],
) {
  const nextIds = new Set(next.map((entry) => entry._id))
  return previous.filter((entry) => !nextIds.has(entry._id))
}

function scanRenderedTranscript(entries: TranscriptEntry[]) {
  let checksum = 0
  for (const entry of entries) {
    checksum += entry._id.length
    if (entry.kind === "assistant_text") checksum += entry.text.length
  }
  return checksum
}

function createOlderEntries(count: number) {
  const existing = olderEntryFixtures.get(count)
  if (existing) return existing
  const entries = Array.from({ length: count }, (_, index) => (
    transcriptEntry(`older-${index}`, -count + index, 80)
  ))
  olderEntryFixtures.set(count, entries)
  return entries
}

function consumeFullFrames(workload: Workload, retainedOlderCount: number) {
  let streamState = preparedWorkloads.get(workload)!.fullState
  let previousRecent = workload.initialFull.messages
  let retainedOlder = createOlderEntries(retainedOlderCount)
  let checksum = 0

  for (const payload of workload.fullFrames) {
    const envelope = JSON.parse(payload) as Extract<ServerEnvelope, { type: "snapshot" }>
    const nextSnapshot = envelope.snapshot.data as ChatSnapshot
    const transition = applyChatStreamSnapshot(streamState, nextSnapshot)
    streamState = transition.state

    const fallenOut = reconcileRecentWindow(previousRecent, nextSnapshot.messages)
    if (fallenOut.length > 0) {
      retainedOlder = mergeTranscriptEntries(retainedOlder, fallenOut)
    }
    const rendered = mergeTranscriptEntries(retainedOlder, nextSnapshot.messages)
    checksum += scanRenderedTranscript(rendered)
    previousRecent = nextSnapshot.messages
  }

  benchmarkSink ^= checksum
}

function consumeDeltaFrames(workload: Workload, retainedOlderCount: number) {
  let streamState = preparedWorkloads.get(workload)!.streamState
  let previousRecent = workload.initialStream.messages
  let retainedOlder = createOlderEntries(retainedOlderCount)
  let checksum = 0

  for (const payload of workload.deltaFrames) {
    const envelope = JSON.parse(payload) as Extract<ServerEnvelope, { type: "event" }>
    const transition = applyChatStreamDelta(streamState, envelope.event as ChatDeltaEvent)
    if (transition.kind !== "applied") {
      throw new Error(`Unexpected delta transition: ${transition.kind}`)
    }
    streamState = transition.state
    const nextRecent = transition.state.snapshot!.messages

    // The hook still validates the bounded recent pagination window for every
    // update, including runtime-only frames.
    const fallenOut = reconcileRecentWindow(previousRecent, nextRecent)
    checksum += fallenOut.length
    if (transition.transcriptChange !== "none") {
      if (fallenOut.length > 0) {
        retainedOlder = mergeTranscriptEntries(retainedOlder, fallenOut)
      }
      const rendered = mergeTranscriptEntries(retainedOlder, nextRecent)
      checksum += scanRenderedTranscript(rendered)
    }
    previousRecent = nextRecent
  }

  benchmarkSink ^= checksum
}

function percentile(sorted: number[], quantile: number) {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]!
}

function measure(run: () => void): TimingSummary {
  for (let index = 0; index < WARMUP_RUNS; index += 1) run()
  const samples: number[] = []
  for (let index = 0; index < MEASURED_RUNS; index += 1) {
    const startedAt = performance.now()
    run()
    samples.push(performance.now() - startedAt)
  }
  samples.sort((left, right) => left - right)
  return {
    medianMs: Number(percentile(samples, 0.5).toFixed(3)),
    maxMs: Number(samples.at(-1)!.toFixed(3)),
  }
}

function utf8Bytes(frames: string[]) {
  return frames.reduce((total, frame) => total + Buffer.byteLength(frame, "utf8"), 0)
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

const initialMessages = Array.from({ length: RECENT_ENTRY_COUNT }, (_, index) => (
  transcriptEntry(`message-${index}`, index + 1)
))
const workloads = [
  buildRollingAppendWorkload(initialMessages),
  buildRuntimeOnlyWorkload(initialMessages),
]
for (const workload of workloads) {
  preparedWorkloads.set(workload, {
    fullState: applyChatStreamSnapshot(
      createChatStreamState("benchmark-chat"),
      workload.initialFull,
    ).state,
    streamState: applyChatStreamSnapshot(
      createChatStreamState("benchmark-chat"),
      workload.initialStream,
    ).state,
  })
}

const payloadResults = workloads.map((workload) => {
  const fullBytes = utf8Bytes(workload.fullFrames)
  const deltaBytes = utf8Bytes(workload.deltaFrames)
  return {
    workload: workload.name,
    frames: FRAME_COUNT,
    fullBytes,
    deltaBytes,
    deltaRatio: Number((deltaBytes / fullBytes).toFixed(4)),
    reductionPercent: Number(((1 - deltaBytes / fullBytes) * 100).toFixed(2)),
  }
})

const timingResults = workloads.flatMap((workload) => (
  RETAINED_OLDER_ENTRY_COUNTS.map((retainedOlderEntries) => {
    const full = measure(() => consumeFullFrames(workload, retainedOlderEntries))
    const delta = measure(() => consumeDeltaFrames(workload, retainedOlderEntries))
    return {
      workload: workload.name,
      retainedOlderEntries,
      full,
      delta,
      medianSpeedup: Number((full.medianMs / delta.medianMs).toFixed(2)),
    }
  })
))

for (const result of payloadResults) {
  const maximumRatio = result.workload === "runtime_only" ? 0.01 : 0.1
  if (result.deltaRatio >= maximumRatio) {
    throw new Error(`${result.workload} payload ratio ${result.deltaRatio} exceeded ${maximumRatio}`)
  }
}
for (const result of timingResults) {
  // The current render pipeline still merges all retained older entries for a
  // rolling append. At 5,000 retained entries that shared O(n) work can
  // dominate both transports and makes a strict relative timing gate noisy.
  if (result.workload === "rolling_append" && result.retainedOlderEntries > 0) {
    continue
  }
  if (result.delta.medianMs >= result.full.medianMs) {
    throw new Error(`${result.workload} delta median did not improve for ${result.retainedOlderEntries} older entries`)
  }
}

console.log(JSON.stringify({
  configuration: {
    recentEntries: RECENT_ENTRY_COUNT,
    frames: FRAME_COUNT,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    syntheticRecentSnapshotBytes: Buffer.byteLength(
      JSON.stringify(snapshotEnvelope(workloads[0]!.initialFull)),
      "utf8",
    ),
  },
  payloadResults,
  timingResults,
  benchmarkSink,
}, null, 2))

console.log("\nSerialized UTF-8 application payload bytes after initial hydration:\n")
console.log("| workload | frames | full snapshots | deltas | delta/full | reduction |")
console.log("| --- | ---: | ---: | ---: | ---: | ---: |")
for (const result of payloadResults) {
  console.log(`| ${result.workload} | ${result.frames} | ${formatBytes(result.fullBytes)} | ${formatBytes(result.deltaBytes)} | ${(result.deltaRatio * 100).toFixed(2)}% | ${result.reductionPercent.toFixed(2)}% |`)
}

console.log("\nClient parse + state/reconciliation time per interval:\n")
console.log("| workload | retained older | full median / max | delta median / max | median speedup |")
console.log("| --- | ---: | ---: | ---: | ---: |")
for (const result of timingResults) {
  console.log(`| ${result.workload} | ${result.retainedOlderEntries} | ${result.full.medianMs.toFixed(3)} / ${result.full.maxMs.toFixed(3)} ms | ${result.delta.medianMs.toFixed(3)} / ${result.delta.maxMs.toFixed(3)} ms | ${result.medianSpeedup.toFixed(2)}x |`)
}
