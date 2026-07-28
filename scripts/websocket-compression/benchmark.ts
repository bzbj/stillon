import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createInterface, type Interface } from "node:readline"
import { connectRawWebSocket, type RawWebSocketClient } from "./raw-websocket-client"
import {
  type BenchmarkWorkerCommand,
  type BenchmarkWorkerEvent,
  type WebSocketCompressionBenchmarkMode,
  type WebSocketCompressionBenchmarkRun,
  type WebSocketCompressionWorkerConfig,
} from "./benchmark-types"
import {
  createSyntheticCorpus,
  DEFAULT_SYNTHETIC_CORPUS_SEED,
  SYNTHETIC_CORPUS_CLASSES,
  type SyntheticCorpusClass,
} from "./synthetic-corpus"

interface BenchmarkOptions {
  classes: SyntheticCorpusClass[]
  clientCounts: number[]
  modes: WebSocketCompressionBenchmarkMode[]
  outputJson?: string
  outputMarkdown?: string
  repetitions: number
  rounds: number
  seed: number
  sizes: number[]
  thresholdBytes: number
}

type PublishedBenchmarkConfiguration = Omit<BenchmarkOptions, "outputJson" | "outputMarkdown">

interface BenchmarkDocument {
  configuration: PublishedBenchmarkConfiguration
  runtime: {
    architecture: string
    bunVersion: string
    platform: NodeJS.Platform
  }
  runs: WebSocketCompressionBenchmarkRun[]
  schemaVersion: 1
}

const ALL_MODES: readonly WebSocketCompressionBenchmarkMode[] = [
  "disabled",
  "shared-uncompressed",
  "shared-forced",
  "shared-threshold",
]

const workerPath = fileURLToPath(new URL("./benchmark-worker.ts", import.meta.url))

function parseInteger(value: string, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received ${value}`)
  }
  return parsed
}

function parseIntegerList(value: string, label: string) {
  return value.split(",").map((entry) => parseInteger(entry.trim(), label))
}

function takeValue(arguments_: string[], index: number, flag: string) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function printHelp() {
  console.log(`Synthetic WebSocket permessage-deflate benchmark

Usage:
  bun scripts/websocket-compression/benchmark.ts [options]

Options:
  --quick                 Run a short threshold-oriented matrix
  --seed N                Deterministic corpus seed (default: 69001)
  --classes CSV           chat-like,mixed,high-entropy
  --sizes CSV             Target UTF-8 payload sizes in bytes
  --clients CSV           Concurrent client counts
  --modes CSV             disabled,shared-uncompressed,shared-forced,
                          shared-threshold
  --repetitions N         Fresh worker processes per case
  --rounds N              Measured rounds per worker
  --threshold N           UTF-8 compression threshold in bytes
  --output-json FILE      Write machine-readable results
  --output-markdown FILE  Write an aggregate table
`)
}

function parseOptions(arguments_: string[]): BenchmarkOptions | null {
  const quick = arguments_.includes("--quick")
  const options: BenchmarkOptions = {
    classes: [...SYNTHETIC_CORPUS_CLASSES],
    clientCounts: [1],
    modes: ["shared-uncompressed", "shared-forced"],
    repetitions: quick ? 1 : 3,
    rounds: quick ? 2 : 3,
    seed: DEFAULT_SYNTHETIC_CORPUS_SEED,
    sizes: quick
      ? [8 * 1024, 32 * 1024, 128 * 1024]
      : [1024, 4 * 1024, 16 * 1024, 32 * 1024, 64 * 1024, 256 * 1024, 512 * 1024],
    thresholdBytes: 32 * 1024,
  }

  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index]!
    if (flag === "--quick") continue
    if (flag === "--help" || flag === "-h") {
      printHelp()
      return null
    }
    const value = takeValue(arguments_, index, flag)
    index++
    if (flag === "--seed") options.seed = parseInteger(value, flag)
    else if (flag === "--sizes") options.sizes = parseIntegerList(value, flag)
    else if (flag === "--clients") options.clientCounts = parseIntegerList(value, flag)
    else if (flag === "--repetitions") options.repetitions = parseInteger(value, flag)
    else if (flag === "--rounds") options.rounds = parseInteger(value, flag)
    else if (flag === "--threshold") options.thresholdBytes = parseInteger(value, flag)
    else if (flag === "--output-json") options.outputJson = value
    else if (flag === "--output-markdown") options.outputMarkdown = value
    else if (flag === "--classes") {
      const classes = value.split(",").map((entry) => entry.trim()) as SyntheticCorpusClass[]
      for (const corpusClass of classes) {
        if (!SYNTHETIC_CORPUS_CLASSES.includes(corpusClass)) {
          throw new Error(`Unsupported corpus class: ${corpusClass}`)
        }
      }
      options.classes = classes
    } else if (flag === "--modes") {
      const modes = value.split(",").map((entry) => entry.trim()) as WebSocketCompressionBenchmarkMode[]
      for (const mode of modes) {
        if (!ALL_MODES.includes(mode)) throw new Error(`Unsupported benchmark mode: ${mode}`)
      }
      options.modes = modes
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }
  return options
}

class WorkerEventReader {
  private readonly lines: Interface
  private readonly iterator: AsyncIterator<string>
  private readonly stderrChunks: Buffer[] = []

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.iterator = this.lines[Symbol.asyncIterator]()
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })
  }

  send(command: BenchmarkWorkerCommand) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  async next<T extends BenchmarkWorkerEvent["type"]>(
    expectedType: T,
    timeoutMs = 10_000,
  ): Promise<Extract<BenchmarkWorkerEvent, { type: T }>> {
    const nextLine = this.iterator.next()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for benchmark worker event ${expectedType}`)),
        timeoutMs,
      )
    })
    const result = await Promise.race([nextLine, timeout])
    if (timer) clearTimeout(timer)
    if (result.done) {
      const stderr = Buffer.concat(this.stderrChunks).toString("utf8").trim()
      throw new Error(`Benchmark worker exited before ${expectedType}${stderr ? `: ${stderr}` : ""}`)
    }
    const event = JSON.parse(result.value) as BenchmarkWorkerEvent
    if (event.type === "error") throw new Error(`Benchmark worker error: ${event.message}`)
    if (event.type !== expectedType) {
      throw new Error(`Expected benchmark worker event ${expectedType}, received ${event.type}`)
    }
    return event as Extract<BenchmarkWorkerEvent, { type: T }>
  }

  close() {
    this.lines.close()
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000) {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for benchmark worker to exit"))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.off("exit", handleExit)
    }
    const handleExit = (code: number | null) => {
      cleanup()
      resolve(code)
    }
    child.once("exit", handleExit)
  })
}

async function runCase(
  config: WebSocketCompressionWorkerConfig,
  repetition: number,
): Promise<WebSocketCompressionBenchmarkRun> {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(config)], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  const worker = new WorkerEventReader(child)
  const clients: RawWebSocketClient[] = []
  let totalFrameBytes = 0
  let totalFramePayloadBytes = 0
  let frameCount = 0
  let compressedMessageCount = 0

  try {
    const ready = await worker.next("ready")
    const expectedCorpora = Array.from({ length: config.clientCount }, (_, clientIndex) =>
      createSyntheticCorpus({
        clientIndex,
        corpusClass: config.corpusClass,
        seed: config.seed,
        targetBytes: config.targetBytes,
      }),
    )
    if (
      ready.actualBytes !== config.targetBytes ||
      ready.payloadHashes.some((hash, index) => hash !== expectedCorpora[index]?.sha256)
    ) {
      throw new Error("Benchmark worker generated an unexpected synthetic corpus")
    }

    for (let clientIndex = 0; clientIndex < config.clientCount; clientIndex++) {
      const client = await connectRawWebSocket(ready.port, { offerCompression: true, timeoutMs: 5_000 })
      const shouldNegotiate = config.mode !== "disabled"
      if (client.negotiatedPerMessageDeflate !== shouldNegotiate) {
        client.destroy()
        throw new Error(`Unexpected permessage-deflate negotiation result for ${config.mode}`)
      }
      clients.push(client)
    }
    await worker.next("connected")

    async function runRound(round: number, measured: boolean) {
      worker.send({ measured, round, type: "round" })
      const messages = await Promise.all(clients.map((client) => client.readMessage()))
      for (let clientIndex = 0; clientIndex < messages.length; clientIndex++) {
        const message = messages[clientIndex]!
        if (message.text !== expectedCorpora[clientIndex]!.payload) {
          throw new Error(`Synthetic payload mismatch for client ${clientIndex}`)
        }
        if (measured) {
          totalFrameBytes += message.totalFrameBytes
          totalFramePayloadBytes += message.framePayloadBytes
          frameCount += message.frameCount
          if (message.compressed) compressedMessageCount++
        }
        clients[clientIndex]!.sendText(JSON.stringify({ round, type: "ack" }))
      }
      const completed = await worker.next("round-complete")
      if (completed.round !== round || completed.measured !== measured) {
        throw new Error("Benchmark worker completed an unexpected round")
      }
    }

    await runRound(-1, false)
    for (let round = 0; round < config.rounds; round++) {
      await runRound(round, true)
    }
    worker.send({ type: "finish" })
    const result = await worker.next("result")
    const totalLogicalBytes = config.targetBytes * config.clientCount * config.rounds

    worker.send({ type: "stop" })
    child.stdin.end()
    const exitCode = await waitForExit(child)
    if (exitCode !== 0) throw new Error(`Benchmark worker exited with code ${exitCode}`)

    return {
      actualBytesPerMessage: ready.actualBytes,
      backpressureCount: result.backpressureCount,
      clientCount: config.clientCount,
      compressedMessageCount,
      corpusClass: config.corpusClass,
      cpuSystemMicros: result.cpuSystemMicros,
      cpuUserMicros: result.cpuUserMicros,
      framePayloadRatio: totalFramePayloadBytes / totalLogicalBytes,
      frameCount,
      mode: config.mode,
      peakRssDeltaBytes: result.peak.rss - result.connectedBaseline.rss,
      repetition,
      rounds: config.rounds,
      seed: config.seed,
      sendDropCount: result.sendDropCount,
      targetBytes: config.targetBytes,
      thresholdBytes: config.thresholdBytes,
      totalFrameBytes,
      totalFramePayloadBytes,
      totalLogicalBytes,
      wallMilliseconds: result.wallMilliseconds,
      wireRatio: totalFrameBytes / totalLogicalBytes,
    }
  } finally {
    for (const client of clients) client.destroy()
    worker.close()
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[middle - 1]! + sorted[middle]!) / 2
  return sorted[middle]!
}

function percentile95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!
}

function renderMarkdown(document: BenchmarkDocument) {
  const groups = new Map<string, WebSocketCompressionBenchmarkRun[]>()
  for (const run of document.runs) {
    const key = [run.mode, run.corpusClass, run.targetBytes, run.clientCount].join("|")
    const group = groups.get(key)
    if (group) group.push(run)
    else groups.set(key, [run])
  }

  const lines = [
    "# Synthetic WebSocket compression benchmark",
    "",
    `Bun ${document.runtime.bunVersion}; ${document.runtime.platform}/${document.runtime.architecture}; seed ${document.configuration.seed}.`,
    "",
    "Wire bytes are WebSocket frame bytes after the HTTP upgrade. CPU and RSS are measured in a fresh server process per run.",
    "",
    "| Mode | Corpus | Bytes | Clients | Runs | Wire ratio median | CPU ms median | CPU ms p95 | Peak RSS delta median |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const runs of groups.values()) {
    const first = runs[0]!
    const cpuMilliseconds = runs.map((run) => (run.cpuUserMicros + run.cpuSystemMicros) / 1_000)
    lines.push(
      `| ${first.mode} | ${first.corpusClass} | ${first.targetBytes} | ${first.clientCount} | ${runs.length} | ` +
        `${median(runs.map((run) => run.wireRatio)).toFixed(4)} | ` +
        `${median(cpuMilliseconds).toFixed(3)} | ${percentile95(cpuMilliseconds).toFixed(3)} | ` +
        `${Math.round(median(runs.map((run) => run.peakRssDeltaBytes)))} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!options) return
  const runs: WebSocketCompressionBenchmarkRun[] = []
  const totalCases =
    options.classes.length *
    options.sizes.length *
    options.clientCounts.length *
    options.modes.length *
    options.repetitions
  let completedCases = 0

  for (const corpusClass of options.classes) {
    for (const targetBytes of options.sizes) {
      for (const clientCount of options.clientCounts) {
        for (const mode of options.modes) {
          for (let repetition = 0; repetition < options.repetitions; repetition++) {
            const config: WebSocketCompressionWorkerConfig = {
              clientCount,
              corpusClass,
              mode,
              rounds: options.rounds,
              seed: options.seed,
              targetBytes,
              thresholdBytes: options.thresholdBytes,
            }
            runs.push(await runCase(config, repetition))
            completedCases++
            process.stderr.write(
              `Completed ${completedCases}/${totalCases}: ${mode}, ${corpusClass}, ${targetBytes} B, ${clientCount} client(s)\n`,
            )
          }
        }
      }
    }
  }

  const document: BenchmarkDocument = {
    configuration: {
      classes: options.classes,
      clientCounts: options.clientCounts,
      modes: options.modes,
      repetitions: options.repetitions,
      rounds: options.rounds,
      seed: options.seed,
      sizes: options.sizes,
      thresholdBytes: options.thresholdBytes,
    },
    runtime: {
      architecture: process.arch,
      bunVersion: Bun.version,
      platform: process.platform,
    },
    runs,
    schemaVersion: 1,
  }
  const markdown = renderMarkdown(document)
  if (options.outputJson) await Bun.write(options.outputJson, `${JSON.stringify(document, null, 2)}\n`)
  if (options.outputMarkdown) await Bun.write(options.outputMarkdown, markdown)
  process.stdout.write(markdown)
}

await main()
