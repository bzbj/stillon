import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { open, type FileHandle } from "node:fs/promises"
import type { TranscriptEntry } from "../shared/types"

const DEFAULT_BLOCK_SIZE = 64 * 1024
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024
const CURSOR_ANCHOR_BYTES = 128
const CURSOR_VERSION = 2 as const

export const MAX_HISTORY_PAGE_SIZE = 500

interface HistoryCursorPayload {
  v: typeof CURSOR_VERSION
  c: string
  r: string
  b: number
  e: number
  n: number
  a: string
}

interface ScannedTranscriptRecord {
  entry: TranscriptEntry
  startOffset: number
}

export interface TranscriptPageReadResult {
  messages: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
  revision: string
  snapshotEnd: number
  bytesRead: number
}

export interface TranscriptPagerOptions {
  blockSize?: number
  maxRecordBytes?: number
  cursorSecret?: Buffer
}

export class HistoryCursorExpiredError extends Error {
  readonly code = "history_cursor_expired"

  constructor() {
    super("History cursor expired. Refresh the chat and try again.")
    this.name = "HistoryCursorExpiredError"
  }
}

export class TranscriptCorruptError extends Error {
  readonly code = "transcript_corrupt"
  readonly offset: number

  constructor(offset: number, cause?: unknown) {
    super(`Transcript contains an invalid JSONL record at byte ${offset}.`, { cause })
    this.name = "TranscriptCorruptError"
    this.offset = offset
  }
}

function isNotFoundError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT"
  )
}

function normalizePageLimit(limit: number) {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(limit)))
}

function hashBytes(value: Buffer) {
  return createHash("sha256").update(value).digest("base64url")
}

function parseTranscriptRecord(raw: Buffer, startOffset: number, maxRecordBytes: number) {
  if (raw.byteLength > maxRecordBytes) {
    throw new Error(`Transcript record at byte ${startOffset} exceeds the ${maxRecordBytes}-byte safety limit.`)
  }

  const text = raw.toString("utf8").trim()
  if (!text) return null

  try {
    return JSON.parse(text) as TranscriptEntry
  } catch (error) {
    throw new TranscriptCorruptError(startOffset, error)
  }
}

export function createTranscriptRevision() {
  return randomBytes(12).toString("base64url")
}

export class TranscriptPager {
  private readonly blockSize: number
  private readonly maxRecordBytes: number
  private readonly cursorSecret: Buffer

  constructor(options: TranscriptPagerOptions = {}) {
    this.blockSize = Math.max(16, Math.floor(options.blockSize ?? DEFAULT_BLOCK_SIZE))
    this.maxRecordBytes = Math.max(this.blockSize, Math.floor(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES))
    this.cursorSecret = Buffer.from(options.cursorSecret ?? randomBytes(32))
  }

  async readRecent(
    filePath: string,
    chatId: string,
    revision: string,
    limit: number,
    capturedSnapshotEnd?: number,
  ): Promise<TranscriptPageReadResult> {
    const normalizedLimit = normalizePageLimit(limit)
    if (normalizedLimit === 0) {
      return {
        messages: [],
        hasOlder: false,
        olderCursor: null,
        revision,
        snapshotEnd: 0,
        bytesRead: 0,
      }
    }

    let handle: FileHandle
    try {
      handle = await open(filePath, "r")
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          messages: [],
          hasOlder: false,
          olderCursor: null,
          revision,
          snapshotEnd: 0,
          bytesRead: 0,
        }
      }
      throw error
    }

    try {
      const currentSize = await this.getFileSize(handle)
      const snapshotEnd = capturedSnapshotEnd ?? currentSize
      if (
        !Number.isSafeInteger(snapshotEnd)
        || snapshotEnd < 0
        || currentSize < snapshotEnd
      ) {
        throw new HistoryCursorExpiredError()
      }
      return await this.readPageFromHandle({
        handle,
        chatId,
        revision,
        beforeOffset: snapshotEnd,
        snapshotEnd,
        limit: normalizedLimit,
        bytesRead: 0,
      })
    } finally {
      await handle.close()
    }
  }

  async readBefore(
    filePath: string,
    chatId: string,
    revision: string,
    cursor: string,
    limit: number,
  ): Promise<TranscriptPageReadResult> {
    const normalizedLimit = normalizePageLimit(limit)
    if (normalizedLimit === 0) {
      return {
        messages: [],
        hasOlder: false,
        olderCursor: null,
        revision,
        snapshotEnd: 0,
        bytesRead: 0,
      }
    }

    const payload = this.decodeCursor(cursor, chatId, revision)
    let handle: FileHandle
    try {
      handle = await open(filePath, "r")
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new HistoryCursorExpiredError()
      }
      throw error
    }

    try {
      const currentSize = await this.getFileSize(handle)
      if (
        currentSize < payload.e
        || payload.b < 0
        || payload.b > payload.e
        || payload.n < 1
        || payload.b + payload.n > currentSize
      ) {
        throw new HistoryCursorExpiredError()
      }

      const anchorBuffer = Buffer.allocUnsafe(payload.n)
      const anchorRead = await handle.read(anchorBuffer, 0, payload.n, payload.b)
      if (anchorRead.bytesRead !== payload.n || hashBytes(anchorBuffer) !== payload.a) {
        throw new HistoryCursorExpiredError()
      }

      return await this.readPageFromHandle({
        handle,
        chatId,
        revision,
        beforeOffset: payload.b,
        snapshotEnd: payload.e,
        limit: normalizedLimit,
        bytesRead: payload.n,
      })
    } finally {
      await handle.close()
    }
  }

  private async getFileSize(handle: FileHandle) {
    const stats = await handle.stat()
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new Error("Transcript is too large to page safely.")
    }
    return stats.size
  }

  private async readPageFromHandle(args: {
    handle: FileHandle
    chatId: string
    revision: string
    beforeOffset: number
    snapshotEnd: number
    limit: number
    bytesRead: number
  }): Promise<TranscriptPageReadResult> {
    const records: ScannedTranscriptRecord[] = []
    const pendingParts: Buffer[] = []
    let pendingBytes = 0
    let position = args.beforeOffset
    let lineEndOffset = args.beforeOffset
    let bytesRead = args.bytesRead

    const consumeRecord = (raw: Buffer, startOffset: number) => {
      const entry = parseTranscriptRecord(raw, startOffset, this.maxRecordBytes)
      if (entry) {
        records.push({ entry, startOffset })
      }
    }

    // Scan raw bytes so UTF-8 code points split across filesystem blocks are
    // decoded only after a complete newline-delimited record is assembled.
    scan: while (position > 0 && records.length <= args.limit) {
      const requestedBytes = Math.min(this.blockSize, position)
      const blockStart = position - requestedBytes
      const blockBuffer = Buffer.allocUnsafe(requestedBytes)
      const readResult = await args.handle.read(blockBuffer, 0, requestedBytes, blockStart)
      if (readResult.bytesRead !== requestedBytes) {
        throw new HistoryCursorExpiredError()
      }
      bytesRead += readResult.bytesRead
      position = blockStart

      const block = blockBuffer.subarray(0, readResult.bytesRead)
      let segmentEnd = block.byteLength
      for (let index = block.byteLength - 1; index >= 0; index -= 1) {
        if (block[index] !== 0x0a) continue

        const lineStartOffset = blockStart + index + 1
        const firstPart = block.subarray(index + 1, segmentEnd)
        const raw = pendingParts.length > 0
          ? Buffer.concat([firstPart, ...pendingParts.slice().reverse()], firstPart.byteLength + pendingBytes)
          : firstPart

        consumeRecord(raw, lineStartOffset)
        pendingParts.length = 0
        pendingBytes = 0
        lineEndOffset = blockStart + index
        segmentEnd = index

        if (records.length > args.limit) {
          break scan
        }
      }

      if (segmentEnd > 0) {
        const prefix = Buffer.from(block.subarray(0, segmentEnd))
        pendingParts.push(prefix)
        pendingBytes += prefix.byteLength
        if (pendingBytes > this.maxRecordBytes) {
          throw new Error(`Transcript record ending at byte ${lineEndOffset} exceeds the ${this.maxRecordBytes}-byte safety limit.`)
        }
      }
    }

    if (position === 0 && pendingParts.length > 0 && records.length <= args.limit) {
      const raw = Buffer.concat(pendingParts.slice().reverse(), pendingBytes)
      consumeRecord(raw, 0)
    }

    const selectedRecords = records.slice(0, args.limit)
    const hasOlder = records.length > args.limit
    const messages = selectedRecords
      .map((record) => record.entry)
      .reverse()

    let olderCursor: string | null = null
    if (hasOlder && selectedRecords.length > 0) {
      const beforeOffset = selectedRecords[selectedRecords.length - 1]!.startOffset
      // The fixed snapshot end makes append-only growth harmless, while the
      // boundary hash detects replacement or truncation before paging again.
      const anchorLength = Math.min(CURSOR_ANCHOR_BYTES, args.snapshotEnd - beforeOffset)
      if (anchorLength < 1) {
        throw new Error("Unable to anchor transcript history cursor.")
      }

      const anchorBuffer = Buffer.allocUnsafe(anchorLength)
      const anchorRead = await args.handle.read(anchorBuffer, 0, anchorLength, beforeOffset)
      if (anchorRead.bytesRead !== anchorLength) {
        throw new HistoryCursorExpiredError()
      }
      bytesRead += anchorRead.bytesRead

      olderCursor = this.encodeCursor({
        v: CURSOR_VERSION,
        c: args.chatId,
        r: args.revision,
        b: beforeOffset,
        e: args.snapshotEnd,
        n: anchorLength,
        a: hashBytes(anchorBuffer),
      })
    }

    return {
      messages,
      hasOlder,
      olderCursor,
      revision: args.revision,
      snapshotEnd: args.snapshotEnd,
      bytesRead,
    }
  }

  private encodeCursor(payload: HistoryCursorPayload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    const signature = createHmac("sha256", this.cursorSecret)
      .update(encodedPayload)
      .digest("base64url")
    return `h2.${encodedPayload}.${signature}`
  }

  private decodeCursor(cursor: string, chatId: string, revision: string) {
    try {
      const [prefix, encodedPayload, encodedSignature, ...rest] = cursor.split(".")
      if (prefix !== "h2" || !encodedPayload || !encodedSignature || rest.length > 0) {
        throw new Error("Invalid cursor shape")
      }

      const expectedSignature = createHmac("sha256", this.cursorSecret)
        .update(encodedPayload)
        .digest()
      const actualSignature = Buffer.from(encodedSignature, "base64url")
      if (
        actualSignature.byteLength !== expectedSignature.byteLength
        || !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        throw new Error("Invalid cursor signature")
      }

      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<HistoryCursorPayload>
      if (
        payload.v !== CURSOR_VERSION
        || payload.c !== chatId
        || payload.r !== revision
        || !Number.isSafeInteger(payload.b)
        || !Number.isSafeInteger(payload.e)
        || !Number.isSafeInteger(payload.n)
        || typeof payload.a !== "string"
        || !payload.a
      ) {
        throw new Error("Invalid cursor payload")
      }

      return payload as HistoryCursorPayload
    } catch (error) {
      if (error instanceof HistoryCursorExpiredError) {
        throw error
      }
      throw new HistoryCursorExpiredError()
    }
  }
}
