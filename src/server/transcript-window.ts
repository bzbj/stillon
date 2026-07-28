import type { TranscriptEntry } from "../shared/types"

const EMPTY_JSON_ARRAY_BYTES = 2
const DEFAULT_MAX_TOOL_BOUNDARY_ADDITIONAL_ENTRIES = 200
const DEFAULT_MAX_TOOL_BOUNDARY_ADDITIONAL_BYTES = 16 * 1024 * 1024

export interface TranscriptWindowBudget {
  maxEntries: number
  maxSerializedBytes?: number
  maxToolBoundaryAdditionalEntries?: number
  maxToolBoundaryAdditionalBytes?: number
}

export interface TranscriptWindowRecord<TPosition> {
  entry: TranscriptEntry
  position: TPosition
  serializedBytes: number
}

export interface TranscriptWindowSelection<TPosition> {
  records: Array<TranscriptWindowRecord<TPosition>>
  hasOlder: boolean
  serializedBytes: number
  budgetExceeded: boolean
  toolBoundaryFallback: boolean
}

function normalizeEntryLimit(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(1, Math.floor(value))
}

function normalizeSerializedByteLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(EMPTY_JSON_ARRAY_BYTES, Math.floor(value))
}

function serializedArrayBytes(entryBytes: number, entryCount: number) {
  return EMPTY_JSON_ARRAY_BYTES + entryBytes + Math.max(0, entryCount - 1)
}

export function getTranscriptEntrySerializedBytes(entry: TranscriptEntry) {
  return Buffer.byteLength(JSON.stringify(entry), "utf8")
}

export function getTranscriptMessagesSerializedBytes(entries: ReadonlyArray<TranscriptEntry>) {
  if (entries.length === 0) return EMPTY_JSON_ARRAY_BYTES
  const entryBytes = entries.reduce(
    (total, entry) => total + getTranscriptEntrySerializedBytes(entry),
    0,
  )
  return serializedArrayBytes(entryBytes, entries.length)
}

/**
 * Accepts transcript records newest-first and commits only boundaries that do
 * not separate tool results from their matching calls.
 */
export class ReverseTranscriptWindowSelector<TPosition> {
  private readonly maxEntries: number
  private readonly maxSerializedBytes: number
  private readonly maxToolBoundaryAdditionalEntries: number
  private readonly maxToolBoundaryAdditionalBytes: number
  private readonly selectedRecords: Array<TranscriptWindowRecord<TPosition>> = []
  private readonly candidateRecords: Array<TranscriptWindowRecord<TPosition>> = []
  private readonly requiredToolCallIds = new Set<string>()
  private selectedEntryBytes = 0
  private candidateEntryBytes = 0
  private hasOlder = false
  private stopped = false
  private budgetExceeded = false
  private toolBoundaryFallback = false

  constructor(budget: TranscriptWindowBudget) {
    this.maxEntries = normalizeEntryLimit(budget.maxEntries)
    this.maxSerializedBytes = normalizeSerializedByteLimit(budget.maxSerializedBytes)
    this.maxToolBoundaryAdditionalEntries = normalizeEntryLimit(
      budget.maxToolBoundaryAdditionalEntries
        ?? DEFAULT_MAX_TOOL_BOUNDARY_ADDITIONAL_ENTRIES,
    )
    this.maxToolBoundaryAdditionalBytes = normalizeSerializedByteLimit(
      budget.maxToolBoundaryAdditionalBytes
        ?? DEFAULT_MAX_TOOL_BOUNDARY_ADDITIONAL_BYTES,
    )
  }

  /**
   * Returns true once the caller can stop scanning older records.
   */
  push(record: TranscriptWindowRecord<TPosition>) {
    if (this.stopped) return true

    if (this.maxEntries === 0) {
      this.hasOlder = true
      this.stopped = true
      return true
    }

    if (this.selectedRecords.length > 0 && this.selectedWindowIsAtCapacity()) {
      this.hasOlder = true
      this.stopped = true
      return true
    }

    this.candidateRecords.push(record)
    this.candidateEntryBytes += record.serializedBytes
    if (record.entry.kind === "tool_result") {
      this.requiredToolCallIds.add(record.entry.toolId)
    } else if (record.entry.kind === "tool_call") {
      this.requiredToolCallIds.delete(record.entry.tool.toolId)
    }

    if (
      this.selectedRecords.length === 0
      && this.candidateRecords.length > 1
      && this.firstToolUnitExceedsHardBoundary()
    ) {
      this.commitNewestRecordFallback()
      return true
    }

    const projectedCount = this.selectedRecords.length + this.candidateRecords.length
    const projectedBytes = serializedArrayBytes(
      this.selectedEntryBytes + this.candidateEntryBytes,
      projectedCount,
    )
    const projectedExceedsBudget = (
      projectedCount > this.maxEntries
      || projectedBytes > this.maxSerializedBytes
    )

    // The pending candidate is entirely older than the committed suffix. Once
    // it cannot fit, no still-older record can make it fit, so leave the whole
    // candidate for the next page.
    if (this.selectedRecords.length > 0 && projectedExceedsBudget) {
      this.hasOlder = true
      this.stopped = true
      this.clearCandidate()
      return true
    }

    if (this.requiredToolCallIds.size > 0) {
      return false
    }

    this.selectedRecords.push(...this.candidateRecords)
    this.selectedEntryBytes += this.candidateEntryBytes
    this.clearCandidate()

    if (projectedExceedsBudget) {
      // The newest complete unit is the progress guarantee: never truncate or
      // omit it, even when one entry or tool span exceeds the soft byte budget.
      this.budgetExceeded = true
    }
    return false
  }

  finish() {
    if (this.candidateRecords.length === 0) return

    if (this.selectedRecords.length > 0) {
      // An orphaned result has no safe boundary in this page. Keep the entire
      // unresolved prefix for the next request instead of splitting it.
      this.hasOlder = true
      this.clearCandidate()
      return
    }

    // Invalid/imported transcripts can contain an orphaned newest result. A
    // one-record fallback guarantees progress without returning the full file.
    this.commitNewestRecordFallback()
  }

  result(): TranscriptWindowSelection<TPosition> {
    return {
      records: [...this.selectedRecords],
      hasOlder: this.hasOlder,
      serializedBytes: serializedArrayBytes(
        this.selectedEntryBytes,
        this.selectedRecords.length,
      ),
      budgetExceeded: this.budgetExceeded,
      toolBoundaryFallback: this.toolBoundaryFallback,
    }
  }

  isAtCapacity() {
    return this.selectedRecords.length > 0 && this.selectedWindowIsAtCapacity()
  }

  stopBeforeOlderRecords() {
    if (this.candidateRecords.length > 0) {
      throw new Error("Cannot stop transcript selection at an unsafe tool boundary.")
    }
    this.hasOlder = true
    this.stopped = true
  }

  canRejectCanonicalOlderRecord(recordBytesSoFar: number) {
    if (
      this.selectedRecords.length === 0
      || this.candidateRecords.length > 0
      || !Number.isFinite(this.maxSerializedBytes)
    ) {
      return false
    }
    const projectedCount = this.selectedRecords.length + 1
    return serializedArrayBytes(
      this.selectedEntryBytes + recordBytesSoFar,
      projectedCount,
    ) > this.maxSerializedBytes
  }

  canFallbackToolBoundaryBeforeCanonicalRecord(recordBytesSoFar: number) {
    if (
      this.selectedRecords.length > 0
      || this.candidateRecords.length === 0
      || this.requiredToolCallIds.size === 0
    ) {
      return false
    }
    const newestRecord = this.candidateRecords[0]
    if (!newestRecord) return false
    const additionalEntries = this.candidateRecords.length
    const additionalBytes = (
      this.candidateEntryBytes
      - newestRecord.serializedBytes
      + recordBytesSoFar
    )
    return (
      additionalEntries > this.maxToolBoundaryAdditionalEntries
      || additionalBytes > this.maxToolBoundaryAdditionalBytes
    )
  }

  fallbackToolBoundaryBeforeOlderRecord() {
    this.commitNewestRecordFallback(true)
  }

  private selectedWindowIsAtCapacity() {
    return (
      this.selectedRecords.length >= this.maxEntries
      || serializedArrayBytes(
        this.selectedEntryBytes,
        this.selectedRecords.length,
      ) >= this.maxSerializedBytes
    )
  }

  private selectedWindowExceedsBudget() {
    return (
      this.selectedRecords.length > this.maxEntries
      || serializedArrayBytes(
        this.selectedEntryBytes,
        this.selectedRecords.length,
      ) > this.maxSerializedBytes
    )
  }

  private firstToolUnitExceedsHardBoundary() {
    const newestRecord = this.candidateRecords[0]
    if (!newestRecord) return false
    const additionalEntries = this.candidateRecords.length - 1
    const additionalBytes = this.candidateEntryBytes - newestRecord.serializedBytes
    return (
      additionalEntries > this.maxToolBoundaryAdditionalEntries
      || additionalBytes > this.maxToolBoundaryAdditionalBytes
    )
  }

  private commitNewestRecordFallback(hasUnparsedOlder = false) {
    const newestRecord = this.candidateRecords[0]
    if (!newestRecord) return
    this.selectedRecords.push(newestRecord)
    this.selectedEntryBytes = newestRecord.serializedBytes
    this.hasOlder = hasUnparsedOlder || this.candidateRecords.length > 1
    this.stopped = true
    this.budgetExceeded = this.selectedWindowExceedsBudget()
    this.toolBoundaryFallback = true
    this.clearCandidate()
  }

  private clearCandidate() {
    this.candidateRecords.length = 0
    this.candidateEntryBytes = 0
    this.requiredToolCallIds.clear()
  }
}

export function selectTranscriptWindowFromEntries(
  entries: ReadonlyArray<TranscriptEntry>,
  endIndex: number,
  budget: TranscriptWindowBudget,
) {
  const selector = new ReverseTranscriptWindowSelector<number>(budget)
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    if (selector.push({
      entry,
      position: index,
      serializedBytes: getTranscriptEntrySerializedBytes(entry),
    })) {
      break
    }
    if (index > 0 && selector.isAtCapacity()) {
      selector.stopBeforeOlderRecords()
      break
    }
  }
  selector.finish()
  const selection = selector.result()
  return {
    ...selection,
    messages: selection.records.map((record) => record.entry).reverse(),
    startIndex: selection.records.at(-1)?.position ?? endIndex,
  }
}
