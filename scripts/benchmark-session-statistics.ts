// Synthetic storage/observation benchmark; no provider calls or user data.
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "../src/server/event-store"
import { ProviderStatistics } from "../src/server/provider-statistics"
import type { HarnessEvent } from "../src/server/harness-types"
const rounds = 5, turns = 100, chunks = 1000
const results: { enabled: boolean; millisecondsPerTurn: number; logBytesPerTurn: number; cpuMillisecondsPerTurn: number; sampledPeakRssBytes: number; sampledPeakHeapBytes: number; p95TranscriptAppendMilliseconds: number; statisticsDrainMilliseconds: number }[] = []
for (let round = 0; round < rounds; round++) for (const enabled of round % 2 ? [true, false] : [false, true]) {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-statistics-bench-"))
  try {
    const store = new EventStore(root, () => enabled ? "benchmark" : null); await store.initialize()
    const project = await store.openProject(path.join(root, "workspace"), "Benchmark"), chat = await store.createChat(project.id)
    const logSize = async () => (await stat(path.join(root, "chats.jsonl"))).size + (await stat(path.join(root, "statistics.jsonl"))).size
    const beforeSize = await logSize()
    const start = performance.now(), cpuStart = process.cpuUsage()
    const appendTimes: number[] = []
    let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed
    for (let turn = 0; turn < turns; turn++) {
      await store.appendMessage(chat.id, { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "user_prompt", content: "Synthetic benchmark" })
      const events: HarnessEvent[] = [], c = enabled ? new ProviderStatistics(e => events.push(e)) : null
      c?.start(100)
      for (let chunk = 0; chunk < chunks; chunk++) c?.delta({ type: "text-delta", text: "x" }, 200 + chunk)
      c?.complete({ inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 5000 }, 2200)
      c?.end(2200)
      for (const event of events) if (event.statistics) store.enqueueStatistics(chat.id, event.statistics)
      const appendStart = performance.now()
      await store.appendMessage(chat.id, { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "assistant_text", text: "x".repeat(chunks) })
      appendTimes.push(performance.now() - appendStart)
      const memory = process.memoryUsage()
      peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed)
    }
    const drainStart = performance.now()
    await store.closeStatistics()
    const statisticsDrainMilliseconds = performance.now() - drainStart
    const cpu = process.cpuUsage(cpuStart)
    appendTimes.sort((a, b) => a - b)
    results.push({ enabled, millisecondsPerTurn: (performance.now() - start) / turns, logBytesPerTurn: ((await logSize()) - beforeSize) / turns,
      cpuMillisecondsPerTurn: (cpu.user + cpu.system) / 1000 / turns,
      sampledPeakRssBytes: peakRss, sampledPeakHeapBytes: peakHeap,
      p95TranscriptAppendMilliseconds: appendTimes[Math.ceil(appendTimes.length * .95) - 1]!, statisticsDrainMilliseconds })
  } finally { await rm(root, { recursive: true, force: true }) }
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
console.log(JSON.stringify({ scope: "Synthetic observation/storage only; sampled process memory includes prior rounds; not provider TPS or network latency", rounds, turnsPerRound: turns, chunksPerTurn: chunks, results,
  medianAdditionalMillisecondsPerTurn: median(results.filter(r => r.enabled).map(r => r.millisecondsPerTurn)) - median(results.filter(r => !r.enabled).map(r => r.millisecondsPerTurn)),
  medianAdditionalCpuMillisecondsPerTurn: median(results.filter(r => r.enabled).map(r => r.cpuMillisecondsPerTurn)) - median(results.filter(r => !r.enabled).map(r => r.cpuMillisecondsPerTurn)),
  medianAdditionalLogBytesPerTurn: median(results.filter(r => r.enabled).map(r => r.logBytesPerTurn)) - median(results.filter(r => !r.enabled).map(r => r.logBytesPerTurn)),
}, null, 2))
