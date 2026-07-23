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

function toJsonl(entries: TranscriptEntry[], lineEnding = "\n", finalNewline = true) {
  const payload = entries.map((value) => JSON.stringify(value)).join(lineEnding)
  return finalNewline && payload ? `${payload}${lineEnding}` : payload
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })))
})

describe("TranscriptPager", () => {
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
