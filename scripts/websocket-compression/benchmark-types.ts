import type { SyntheticCorpusClass } from "./synthetic-corpus"

export type WebSocketCompressionBenchmarkMode =
  | "disabled"
  | "shared-uncompressed"
  | "shared-forced"
  | "shared-threshold"

export interface WebSocketCompressionWorkerConfig {
  clientCount: number
  corpusClass: SyntheticCorpusClass
  mode: WebSocketCompressionBenchmarkMode
  rounds: number
  seed: number
  targetBytes: number
  thresholdBytes: number
}

export interface BenchmarkMemorySnapshot {
  arrayBuffers: number
  external: number
  heapUsed: number
  rss: number
}

export type BenchmarkWorkerCommand =
  | { type: "round"; measured: boolean; round: number }
  | { type: "finish" }
  | { type: "stop" }

export type BenchmarkWorkerEvent =
  | {
      actualBytes: number
      payloadHashes: string[]
      port: number
      type: "ready"
    }
  | { connectionCount: number; type: "connected" }
  | { measured: boolean; round: number; type: "round-complete" }
  | {
      backpressureCount: number
      connectedBaseline: BenchmarkMemorySnapshot
      cpuSystemMicros: number
      cpuUserMicros: number
      maxRssNativeUnits: number
      messageCount: number
      peak: BenchmarkMemorySnapshot
      postWarmup: BenchmarkMemorySnapshot
      sendDropCount: number
      settledEnd: BenchmarkMemorySnapshot
      type: "result"
      wallMilliseconds: number
    }
  | { message: string; type: "error" }

export interface WebSocketCompressionBenchmarkRun {
  actualBytesPerMessage: number
  backpressureCount: number
  clientCount: number
  compressedMessageCount: number
  corpusClass: SyntheticCorpusClass
  cpuSystemMicros: number
  cpuUserMicros: number
  framePayloadRatio: number
  frameCount: number
  mode: WebSocketCompressionBenchmarkMode
  peakRssDeltaBytes: number
  repetition: number
  rounds: number
  seed: number
  sendDropCount: number
  targetBytes: number
  thresholdBytes: number
  totalFrameBytes: number
  totalFramePayloadBytes: number
  totalLogicalBytes: number
  wallMilliseconds: number
  wireRatio: number
}
