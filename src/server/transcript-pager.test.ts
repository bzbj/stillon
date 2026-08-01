import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import {
  HistoryCursorExpiredError,
  TranscriptCorruptError,
  TranscriptPager,
  createTranscriptRevision,
} from "./transcript-pager"
import { getTranscriptMessagesSerializedBytes } from "./transcript-window"

const tempDirs: string[] = []

async function createTranscriptPath() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-transcript-pager-"))
  tempDirs.push(dataDir)
  return path.join(dataDir, "chat.jsonl")
}

function entry(index: number, text = `message-${index}`): TranscriptEntry {
  return {
    _id: `message-${index}`,
    kind: "assistant_text",
    createdAt: index,
    text,
  }
}

function toolCall(index: number, toolId: string): TranscriptEntry {
  return {
    _id: `tool-call-${index}`,
    kind: "tool_call",
    createdAt: index,
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName: "Example",
      toolId,
      input: { payload: {} },
    },
  }
}

function toolResult(index: number, toolId: string, content: unknown): TranscriptEntry {
  return {
    _id: `tool-result-${index}`,
    kind: "tool_result",
    createdAt: index,
    toolId,
    content,
  }
}

function toJsonl(entries: TranscriptEntry[], lineEnding = "\n", finalNewline = true) {
  const payload = entries.map((value) => JSON.stringify(value)).join(lineEnding)
  return finalNewline && payload ? `${payload}${lineEnding}` : payload
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })))
})

describe("TranscriptPager", () => {
  test("fills the visible-row budget through a tool-heavy tail", async () => {
    const transcriptPath = await createTranscriptPath()
    const readable = Array.from({ length: 39 }, (_, index) => entry(index + 1))
    const tools = Array.from({ length: 100 }, (_, index) => [
      toolCall(1000 + index * 2, `tool-${index}`),
      toolResult(1001 + index * 2, `tool-${index}`, "large output".repeat(100)),
    ]).flat()
    await writeFile(transcriptPath, toJsonl([...readable, ...tools]), "utf8")

    const pager = new TranscriptPager({ blockSize: 256, cursorSecret: Buffer.alloc(32, 19) })
    const page = await pager.readRecent(transcriptPath, "chat-1", createTranscriptRevision(), 40, undefined, 512 * 1024)

    expect(page.messages.filter((message) => message.kind === "assistant_text")).toHaveLength(39)
    expect(page.messages.filter((message) => message.kind === "tool_summary")).toHaveLength(100)
    expect(page.hasOlder).toBe(false)
    expect(page.serializedBytes).toBeLessThan(512 * 1024)
  })

  test("reads recent and older pages in transcript order", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = Array.from({ length: 7 }, (_, index) => entry(index + 1))
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 64, cursorSecret: Buffer.alloc(32, 1) })
    const revision = createTranscriptRevision()
    const recent = await pager.readRecent(transcriptPath, "chat-1", revision, 3)

    expect(recent.messages.map((message) => message._id)).toEqual(["message-5", "message-6", "message-7"])
    expect(recent.hasOlder).toBe(true)
    expect(recent.olderCursor?.startsWith("h2.")).toBe(true)
    expect(recent.revision).toBe(revision)

    const middle = await pager.readBefore(transcriptPath, "chat-1", revision, recent.olderCursor!, 3)
    expect(middle.messages.map((message) => message._id)).toEqual(["message-2", "message-3", "message-4"])
    expect(middle.hasOlder).toBe(true)

    const oldest = await pager.readBefore(transcriptPath, "chat-1", revision, middle.olderCursor!, 3)
    expect(oldest.messages.map((message) => message._id)).toEqual(["message-1"])
    expect(oldest.hasOlder).toBe(false)
    expect(oldest.olderCursor).toBeNull()
  })

  test("reads only tail blocks needed for the requested page", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = Array.from({ length: 10_000 }, (_, index) => entry(index, "x".repeat(80)))
    const payload = toJsonl(entries)
    await writeFile(transcriptPath, payload, "utf8")

    const pager = new TranscriptPager({ blockSize: 1024, cursorSecret: Buffer.alloc(32, 2) })
    const page = await pager.readRecent(transcriptPath, "chat-1", createTranscriptRevision(), 10)

    expect(page.messages).toHaveLength(10)
    expect(page.bytesRead).toBeLessThan(4 * 1024)
    expect(page.bytesRead).toBeLessThan(payload.length / 100)
  })

  test("does not assemble a huge excluded record just to detect older history", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "x".repeat(2 * 1024 * 1024)),
      entry(2, "newest"),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 1024, cursorSecret: Buffer.alloc(32, 13) })
    const byteBudget = getTranscriptMessagesSerializedBytes([entries[1]!]) + 1024
    const page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      createTranscriptRevision(),
      40,
      undefined,
      byteBudget,
    )

    expect(page.messages.map((message) => message._id)).toEqual(["message-2"])
    expect(page.hasOlder).toBe(true)
    expect(page.bytesRead).toBeLessThan(4 * 1024)
  })

  test("selects the largest recent suffix within an exact UTF-8 byte budget", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "oldest"),
      entry(2, "界".repeat(2_000)),
      entry(3, "recent-3"),
      entry(4, "recent-4"),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 128, cursorSecret: Buffer.alloc(32, 8) })
    const exactBudget = getTranscriptMessagesSerializedBytes(entries.slice(2))
    const page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      createTranscriptRevision(),
      40,
      undefined,
      exactBudget,
    )

    expect(page.messages.map((message) => message._id)).toEqual(["message-3", "message-4"])
    expect(page.serializedBytes).toBe(exactBudget)
    expect(page.budgetExceeded).toBe(false)
    expect(page.hasOlder).toBe(true)
  })

  test("returns one oversized newest entry so pagination always makes progress", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "older"),
      entry(2, "界".repeat(4_000)),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 128, cursorSecret: Buffer.alloc(32, 9) })
    const revision = createTranscriptRevision()
    const recent = await pager.readRecent(
      transcriptPath,
      "chat-1",
      revision,
      40,
      undefined,
      256,
    )

    expect(recent.messages.map((message) => message._id)).toEqual(["message-2"])
    expect(recent.serializedBytes).toBeGreaterThan(256)
    expect(recent.budgetExceeded).toBe(true)
    expect(recent.hasOlder).toBe(true)

    const older = await pager.readBefore(
      transcriptPath,
      "chat-1",
      revision,
      recent.olderCursor!,
      60,
    )
    expect(older.messages.map((message) => message._id)).toEqual(["message-1"])
  })

  test("keeps tool units cursor-safe while transporting completed tools as summaries", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "older"),
      toolCall(2, "tool-a"),
      toolCall(3, "tool-b"),
      toolResult(4, "tool-a", "x".repeat(2_000)),
      toolResult(5, "tool-b", "done"),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 128, cursorSecret: Buffer.alloc(32, 10) })
    const page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      createTranscriptRevision(),
      2,
      undefined,
      256,
    )

    expect(page.messages.map((message) => message._id)).toEqual([
      "tool-call-2",
      "tool-call-3",
    ])
    expect(page.messages.every((message) => message.kind === "tool_summary")).toBe(true)
    expect(page.hasOlder).toBe(true)
  })

  test("bounds an unresolved newest tool result instead of scanning the full transcript", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      ...Array.from({ length: 1_000 }, (_, index) => entry(index + 1, "x".repeat(80))),
      toolResult(1_001, "missing-tool", "orphan"),
    ]
    const payload = toJsonl(entries)
    await writeFile(transcriptPath, payload, "utf8")

    const pager = new TranscriptPager({ blockSize: 1024, cursorSecret: Buffer.alloc(32, 14) })
    const revision = createTranscriptRevision()
    let page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      revision,
      40,
      undefined,
      512 * 1024,
    )

    expect(page.messages.map((message) => message._id)).toEqual(["tool-result-1001"])
    expect(page.toolBoundaryFallback).toBe(true)
    expect(page.hasOlder).toBe(true)
    expect(page.bytesRead).toBeLessThan(payload.length / 2)

    let reconstructed = [...page.messages]
    while (page.hasOlder) {
      page = await pager.readBefore(
        transcriptPath,
        "chat-1",
        revision,
        page.olderCursor!,
        60,
      )
      reconstructed = [...page.messages, ...reconstructed]
    }
    expect(reconstructed.map((message) => message._id)).toEqual(
      entries.map((message) => message._id),
    )
  })

  test("applies the hard tool-boundary byte limit before parsing a huge older record", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "x".repeat(20 * 1024 * 1024)),
      toolResult(2, "missing-tool", "orphan"),
    ]
    const payload = toJsonl(entries)
    await writeFile(transcriptPath, payload, "utf8")

    const pager = new TranscriptPager({
      blockSize: 64 * 1024,
      cursorSecret: Buffer.alloc(32, 15),
    })
    const page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      createTranscriptRevision(),
      40,
      undefined,
      512 * 1024,
    )

    expect(page.messages.map((message) => message._id)).toEqual(["tool-result-2"])
    expect(page.toolBoundaryFallback).toBe(true)
    expect(page.hasOlder).toBe(true)
    expect(page.bytesRead).toBeLessThan(17 * 1024 * 1024)
    expect(page.bytesRead).toBeLessThan(payload.length)
  })

  test("leaves an older tool unit whole for the next page", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "oldest"),
      toolCall(2, "tool-a"),
      toolResult(3, "tool-a", "x".repeat(2_000)),
      entry(4, "newest"),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 128, cursorSecret: Buffer.alloc(32, 11) })
    const revision = createTranscriptRevision()
    const recentBudget = getTranscriptMessagesSerializedBytes([entries[3]!])
    const recent = await pager.readRecent(
      transcriptPath,
      "chat-1",
      revision,
      40,
      undefined,
      recentBudget,
    )
    const older = await pager.readBefore(
      transcriptPath,
      "chat-1",
      revision,
      recent.olderCursor!,
      1,
    )

    expect(recent.messages.map((message) => message._id)).toEqual(["message-4"])
    expect(older.messages.map((message) => message._id)).toEqual([
      "tool-call-2",
    ])
    expect(older.messages[0]?.kind).toBe("tool_summary")
    expect(older.hasOlder).toBe(true)
  })

  test("reconstructs tool-safe pages without gaps or duplicates", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1),
      toolCall(2, "tool-a"),
      toolCall(3, "tool-b"),
      toolResult(4, "tool-a", "a"),
      toolResult(5, "tool-b", "b"),
      entry(6),
      toolCall(7, "pending"),
    ]
    await writeFile(transcriptPath, toJsonl(entries), "utf8")

    const pager = new TranscriptPager({ blockSize: 64, cursorSecret: Buffer.alloc(32, 12) })
    const revision = createTranscriptRevision()
    let page = await pager.readRecent(transcriptPath, "chat-1", revision, 2)
    let reconstructed = [...page.messages]

    while (page.hasOlder) {
      page = await pager.readBefore(
        transcriptPath,
        "chat-1",
        revision,
        page.olderCursor!,
        2,
      )
      reconstructed = [...page.messages, ...reconstructed]
    }

    expect(reconstructed.map((message) => message._id)).toEqual([
      "message-1",
      "tool-call-2",
      "tool-call-3",
      "message-6",
      "tool-call-7",
    ])
    expect(new Set(reconstructed.map((message) => message._id)).size).toBe(reconstructed.length)
  })

  test("keeps an older cursor valid when new records are appended", async () => {
    const transcriptPath = await createTranscriptPath()
    await writeFile(transcriptPath, toJsonl([entry(1), entry(2), entry(3), entry(4)]), "utf8")

    const pager = new TranscriptPager({ blockSize: 64, cursorSecret: Buffer.alloc(32, 3) })
    const revision = createTranscriptRevision()
    const recent = await pager.readRecent(transcriptPath, "chat-1", revision, 2)

    await appendFile(transcriptPath, toJsonl([entry(5), entry(6)]), "utf8")
    const older = await pager.readBefore(transcriptPath, "chat-1", revision, recent.olderCursor!, 2)

    expect(older.messages.map((message) => message._id)).toEqual(["message-1", "message-2"])
    expect(older.hasOlder).toBe(false)
  })

  test("honors a captured snapshot end when an append wins the open race", async () => {
    const transcriptPath = await createTranscriptPath()
    await writeFile(transcriptPath, toJsonl([entry(1), entry(2), entry(3)]), "utf8")
    const snapshotEnd = (await stat(transcriptPath)).size
    await appendFile(transcriptPath, toJsonl([entry(4)]), "utf8")

    const pager = new TranscriptPager({ blockSize: 64, cursorSecret: Buffer.alloc(32, 7) })
    const page = await pager.readRecent(
      transcriptPath,
      "chat-1",
      createTranscriptRevision(),
      2,
      snapshotEnd,
    )

    expect(page.messages.map((message) => message._id)).toEqual(["message-2", "message-3"])
    expect(page.snapshotEnd).toBe(snapshotEnd)
  })

  test("handles UTF-8 records spanning many blocks, CRLF, blank lines, and no final newline", async () => {
    const transcriptPath = await createTranscriptPath()
    const entries = [
      entry(1, "第一条"),
      entry(2, "界".repeat(5_000)),
      entry(3, "last"),
    ]
    const payload = `${JSON.stringify(entries[0])}\r\n\r\n${JSON.stringify(entries[1])}\r\n${JSON.stringify(entries[2])}`
    await writeFile(transcriptPath, payload, "utf8")

    const pager = new TranscriptPager({
      blockSize: 128,
      maxRecordBytes: 128 * 1024,
      cursorSecret: Buffer.alloc(32, 4),
    })
    const page = await pager.readRecent(transcriptPath, "chat-1", createTranscriptRevision(), 10)

    expect(page.messages).toEqual(entries)
    expect(page.hasOlder).toBe(false)
  })

  test("rejects tampered, cross-chat, stale, and truncated cursors", async () => {
    const transcriptPath = await createTranscriptPath()
    await writeFile(transcriptPath, toJsonl([entry(1), entry(2), entry(3)]), "utf8")

    const pager = new TranscriptPager({ blockSize: 64, cursorSecret: Buffer.alloc(32, 5) })
    const revision = createTranscriptRevision()
    const recent = await pager.readRecent(transcriptPath, "chat-1", revision, 1)
    const cursor = recent.olderCursor!

    await expect(pager.readBefore(transcriptPath, "chat-1", revision, `${cursor}x`, 1))
      .rejects.toBeInstanceOf(HistoryCursorExpiredError)
    await expect(pager.readBefore(transcriptPath, "chat-2", revision, cursor, 1))
      .rejects.toBeInstanceOf(HistoryCursorExpiredError)
    await expect(pager.readBefore(transcriptPath, "chat-1", createTranscriptRevision(), cursor, 1))
      .rejects.toBeInstanceOf(HistoryCursorExpiredError)

    await writeFile(transcriptPath, toJsonl([entry(1)]), "utf8")
    await expect(pager.readBefore(transcriptPath, "chat-1", revision, cursor, 1))
      .rejects.toBeInstanceOf(HistoryCursorExpiredError)
  })

  test("reports malformed complete records without modifying the transcript", async () => {
    const transcriptPath = await createTranscriptPath()
    const payload = `${JSON.stringify(entry(1))}\n{\"broken\":\n${JSON.stringify(entry(2))}\n`
    await writeFile(transcriptPath, payload, "utf8")

    const pager = new TranscriptPager({ blockSize: 32, cursorSecret: Buffer.alloc(32, 6) })
    await expect(pager.readRecent(transcriptPath, "chat-1", createTranscriptRevision(), 10))
      .rejects.toBeInstanceOf(TranscriptCorruptError)
    expect(await Bun.file(transcriptPath).text()).toBe(payload)
  })
})
