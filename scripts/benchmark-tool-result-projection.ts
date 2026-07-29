import { Buffer } from "node:buffer"
import type { ToolResultEntry, TranscriptEntry } from "../src/shared/types"
import {
  DEFAULT_TOOL_RESULT_INLINE_BYTES,
  DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
  projectToolResultEntries,
} from "../src/server/tool-result-projection"

const TOOL_RESULT_COUNT = 200
const LARGE_RESULT_COUNT = 12
const ITERATIONS = Math.max(
  3,
  Number.parseInt(process.env.STILLON_BENCHMARK_ITERATIONS ?? "15", 10) || 15,
)
const REVISION = "synthetic-benchmark-revision"
const LARGE_SENTINEL = "STILLON_SYNTHETIC_LARGE_RESULT_SENTINEL"

function createToolCall(index: number): TranscriptEntry {
  const tool = index % 5 === 0
    ? {
        kind: "tool" as const,
        toolKind: "read_file" as const,
        toolName: "Read",
        toolId: `tool-${index}`,
        input: { filePath: `/synthetic/file-${index}.txt` },
      }
    : {
        kind: "tool" as const,
        toolKind: "bash" as const,
        toolName: "Bash",
        toolId: `tool-${index}`,
        input: { command: `synthetic-command-${index}` },
      }
  return {
    _id: `call-${index}`,
    kind: "tool_call",
    createdAt: index * 2,
    tool,
  }
}

function createLargeContent(index: number) {
  const targetBytes = (1 + (index % 4)) * 1024 * 1024
  if (index % 3 === 0) {
    return `${"text output\n".repeat(
      Math.ceil(targetBytes / 12),
    )}\n${LARGE_SENTINEL}:${index}`
  }
  if (index % 3 === 1) {
    return {
      records: Array.from({ length: Math.ceil(targetBytes / 96) }, (_, row) => ({
        row,
        status: row % 2 === 0 ? "ok" : "pending",
        value: `synthetic-value-${index}-${row}`,
      })),
      sentinel: `${LARGE_SENTINEL}:${index}`,
    }
  }

  return {
    content: [{
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.alloc(targetBytes, index).toString("base64"),
      },
    }],
    previewPadding: "p".repeat(4 * 1024),
    sentinel: `${LARGE_SENTINEL}:${index}`,
  }
}

function createToolResult(index: number): ToolResultEntry {
  const large = index < LARGE_RESULT_COUNT
  return {
    _id: `result-${index}`,
    kind: "tool_result",
    toolId: `tool-${index}`,
    createdAt: index * 2 + 1,
    content: large
      ? createLargeContent(index)
      : `small synthetic result ${index}\n${"x".repeat(2 * 1024)}`,
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

function measureJsonParse(payload: string) {
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now()
    JSON.parse(payload)
    samples.push(performance.now() - startedAt)
  }
  return median(samples)
}

function envelope(messages: TranscriptEntry[]) {
  return {
    v: 1,
    type: "snapshot",
    id: "synthetic-benchmark",
    snapshot: {
      type: "chat",
      data: {
        messages,
        history: {
          revision: REVISION,
          hasOlder: false,
          olderCursor: null,
          recentLimit: TOOL_RESULT_COUNT * 2,
        },
      },
    },
  }
}

const rawMessages = Array.from({ length: TOOL_RESULT_COUNT }, (_, index) => [
  createToolCall(index),
  createToolResult(index),
]).flat()
const rawPayload = JSON.stringify(envelope(rawMessages))
const projectedMessages = projectToolResultEntries(rawMessages, REVISION, {
  inlineBytes: DEFAULT_TOOL_RESULT_INLINE_BYTES,
  previewBytes: DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
})
const projectedPayload = JSON.stringify(envelope(projectedMessages))

const deferredCount = projectedMessages.filter((entry) => (
  entry.kind === "tool_result" && entry.deferredContent
)).length
if (deferredCount !== LARGE_RESULT_COUNT) {
  throw new Error(
    `Expected ${LARGE_RESULT_COUNT} deferred results, received ${deferredCount}.`,
  )
}
if (projectedPayload.includes(LARGE_SENTINEL)) {
  throw new Error("Projected payload leaked a synthetic large-result sentinel.")
}
if (!rawPayload.includes(LARGE_SENTINEL)) {
  throw new Error("Raw benchmark payload is missing its synthetic sentinel.")
}

const rawBytes = Buffer.byteLength(rawPayload, "utf8")
const projectedBytes = Buffer.byteLength(projectedPayload, "utf8")
const reductionPercent = (1 - projectedBytes / rawBytes) * 100
const rawParseMs = measureJsonParse(rawPayload)
const projectedParseMs = measureJsonParse(projectedPayload)

console.log(JSON.stringify({
  fixture: {
    toolResults: TOOL_RESULT_COUNT,
    largeToolResults: LARGE_RESULT_COUNT,
    inlineBytes: DEFAULT_TOOL_RESULT_INLINE_BYTES,
    previewBytes: DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
    syntheticOnly: true,
  },
  payload: {
    rawBytes,
    projectedBytes,
    reductionPercent: Number(reductionPercent.toFixed(2)),
  },
  parse: {
    iterations: ITERATIONS,
    rawMedianMs: Number(rawParseMs.toFixed(2)),
    projectedMedianMs: Number(projectedParseMs.toFixed(2)),
    speedup: Number((rawParseMs / projectedParseMs).toFixed(2)),
  },
}, null, 2))
