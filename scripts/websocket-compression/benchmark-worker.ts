import { createInterface } from "node:readline"
import type { ServerWebSocket } from "bun"
import {
  getWebSocketSendPolicy,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
} from "../../src/server/websocket-compression"
import type {
  BenchmarkMemorySnapshot,
  BenchmarkWorkerCommand,
  BenchmarkWorkerEvent,
  WebSocketCompressionWorkerConfig,
} from "./benchmark-types"
import { createSyntheticCorpus } from "./synthetic-corpus"

interface BenchmarkClientData {
  clientIndex: number
}

interface ActiveRound {
  awaitingClientIndexes: Set<number>
  measured: boolean
  round: number
}

function emit(event: BenchmarkWorkerEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function readConfig(): WebSocketCompressionWorkerConfig {
  const rawConfig = process.argv[2]
  if (!rawConfig) throw new Error("benchmark-worker requires a JSON configuration argument")
  return JSON.parse(rawConfig) as WebSocketCompressionWorkerConfig
}

function memorySnapshot(): BenchmarkMemorySnapshot {
  const usage = process.memoryUsage()
  return {
    arrayBuffers: usage.arrayBuffers,
    external: usage.external,
    heapUsed: usage.heapUsed,
    rss: usage.rss,
  }
}

function maxMemory(left: BenchmarkMemorySnapshot, right: BenchmarkMemorySnapshot) {
  return {
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
    external: Math.max(left.external, right.external),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    rss: Math.max(left.rss, right.rss),
  }
}

const config = readConfig()
const corpora = Array.from({ length: config.clientCount }, (_, clientIndex) =>
  createSyntheticCorpus({
    clientIndex,
    corpusClass: config.corpusClass,
    seed: config.seed,
    targetBytes: config.targetBytes,
  }),
)
const sockets = new Map<number, ServerWebSocket<BenchmarkClientData>>()
let nextClientIndex = 0
let activeRound: ActiveRound | null = null
let connectedBaseline = memorySnapshot()
let postWarmup = connectedBaseline
let peak = connectedBaseline
let sampleTimer: ReturnType<typeof setInterval> | null = null
let startCpu: NodeJS.CpuUsage | null = null
let startWall = 0
let messageCount = 0
let backpressureCount = 0
let sendDropCount = 0

const perMessageDeflate =
  config.mode === "disabled"
    ? false
    : WEBSOCKET_PER_MESSAGE_DEFLATE

function shouldCompress(payload: string) {
  if (config.mode === "shared-forced") return true
  if (config.mode === "shared-threshold") {
    return getWebSocketSendPolicy(payload, config.thresholdBytes).compress
  }
  return false
}

function sampleMemory() {
  peak = maxMemory(peak, memorySnapshot())
}

function completeRound(round: ActiveRound) {
  activeRound = null
  sampleMemory()
  if (!round.measured) postWarmup = memorySnapshot()
  emit({ measured: round.measured, round: round.round, type: "round-complete" })
}

const server = Bun.serve<BenchmarkClientData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname !== "/ws") return new Response("Not found", { status: 404 })
    if (nextClientIndex >= config.clientCount) {
      return new Response("Too many benchmark clients", { status: 503 })
    }
    const clientIndex = nextClientIndex++
    const upgraded = bunServer.upgrade(request, { data: { clientIndex } })
    if (!upgraded) return new Response("Upgrade failed", { status: 400 })
  },
  websocket: {
    perMessageDeflate,
    open(ws) {
      sockets.set(ws.data.clientIndex, ws)
      if (sockets.size === config.clientCount) {
        connectedBaseline = memorySnapshot()
        postWarmup = connectedBaseline
        peak = connectedBaseline
        emit({ connectionCount: sockets.size, type: "connected" })
      }
    },
    message(ws, rawMessage) {
      if (!activeRound) return
      const text = (() => {
        if (typeof rawMessage === "string") return rawMessage
        if (rawMessage instanceof ArrayBuffer) return Buffer.from(rawMessage).toString("utf8")
        return Buffer.from(rawMessage).toString("utf8")
      })()
      let acknowledgement: { round?: number; type?: string }
      try {
        acknowledgement = JSON.parse(text) as { round?: number; type?: string }
      } catch {
        emit({ message: "Client sent invalid benchmark acknowledgement JSON", type: "error" })
        return
      }
      if (
        acknowledgement.type !== "ack" ||
        acknowledgement.round !== activeRound.round ||
        !activeRound.awaitingClientIndexes.delete(ws.data.clientIndex)
      ) {
        emit({ message: "Client sent an unexpected benchmark acknowledgement", type: "error" })
        return
      }
      if (activeRound.awaitingClientIndexes.size === 0) completeRound(activeRound)
    },
    close(ws) {
      sockets.delete(ws.data.clientIndex)
    },
  },
})

const serverPort = server.port
if (serverPort === undefined) throw new Error("Benchmark worker did not bind an ephemeral port")
emit({
  actualBytes: corpora[0]!.actualBytes,
  payloadHashes: corpora.map((corpus) => corpus.sha256),
  port: serverPort,
  type: "ready",
})

async function handleCommand(command: BenchmarkWorkerCommand) {
  if (command.type === "round") {
    if (activeRound) throw new Error("A benchmark round is already active")
    if (sockets.size !== config.clientCount) {
      throw new Error(`Expected ${config.clientCount} clients, found ${sockets.size}`)
    }
    if (command.measured && !startCpu) {
      startCpu = process.cpuUsage()
      startWall = performance.now()
      peak = memorySnapshot()
      sampleTimer = setInterval(sampleMemory, 5)
    }

    activeRound = {
      awaitingClientIndexes: new Set(sockets.keys()),
      measured: command.measured,
      round: command.round,
    }
    for (const [clientIndex, socket] of sockets) {
      const payload = corpora[clientIndex]!.payload
      const sendResult = socket.send(payload, shouldCompress(payload))
      if (command.measured) {
        messageCount++
        if (sendResult < 0) backpressureCount++
        if (sendResult === 0) sendDropCount++
      }
    }
    sampleMemory()
    return
  }

  if (command.type === "finish") {
    if (activeRound) throw new Error("Cannot finish while a benchmark round is active")
    if (!startCpu) throw new Error("Cannot finish before a measured round")
    if (sampleTimer) clearInterval(sampleTimer)
    sampleTimer = null
    const cpu = process.cpuUsage(startCpu)
    const wallMilliseconds = performance.now() - startWall
    sampleMemory()
    await Bun.sleep(20)
    const settledEnd = memorySnapshot()
    emit({
      backpressureCount,
      connectedBaseline,
      cpuSystemMicros: cpu.system,
      cpuUserMicros: cpu.user,
      maxRssNativeUnits: process.resourceUsage().maxRSS,
      messageCount,
      peak,
      postWarmup,
      sendDropCount,
      settledEnd,
      type: "result",
      wallMilliseconds,
    })
    return
  }

  if (sampleTimer) clearInterval(sampleTimer)
  await server.stop(true)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  for await (const line of lines) {
    if (!line.trim()) continue
    const command = JSON.parse(line) as BenchmarkWorkerCommand
    await handleCommand(command)
    if (command.type === "stop") break
  }
  lines.close()
} catch (error) {
  emit({ message: error instanceof Error ? error.message : String(error), type: "error" })
  if (sampleTimer) clearInterval(sampleTimer)
  await server.stop(true)
  process.exitCode = 1
}
