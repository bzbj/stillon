import type { ToolSummaryEntry, TranscriptEntry } from "../shared/types"
import { SPECIAL_TRANSCRIPT_TOOL_NAMES } from "../shared/transcript-history"

export function getHistoricalTransportBudgetBytes(entry: TranscriptEntry) {
  if (entry.kind === "tool_call" && !SPECIAL_TRANSCRIPT_TOOL_NAMES.has(entry.tool.toolName)) return 256
  if (entry.kind === "tool_result") return 64
  return Buffer.byteLength(JSON.stringify(entry), "utf8")
}

export function isCollapsibleTranscriptTool(entry: TranscriptEntry) {
  if (entry.kind === "tool_summary") {
    return !SPECIAL_TRANSCRIPT_TOOL_NAMES.has(entry.toolName)
  }
  return entry.kind === "tool_call" && !SPECIAL_TRANSCRIPT_TOOL_NAMES.has(entry.tool.toolName)
}

/** Counts rows the transcript can actually render, after hidden records are removed
 * and adjacent ordinary tool calls are collapsed into one row. */
export function countVisibleTranscriptRows(entries: ReadonlyArray<TranscriptEntry>) {
  let count = 0
  let ordinaryToolRun = false
  let sawSystem = false
  let sawAccount = false

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.hidden) continue

    if (isCollapsibleTranscriptTool(entry)) {
      if (!ordinaryToolRun) count += 1
      ordinaryToolRun = true
      continue
    }

    switch (entry.kind) {
      case "tool_result":
      case "context_window_updated":
      case "compact_boundary":
        continue
      case "status":
        // Only the final transcript status is rendered.
        if (index !== entries.length - 1) continue
        break
      case "result":
        if (!entry.isError && entry.durationMs <= 60_000) continue
        break
      case "system_init":
        if (sawSystem) continue
        sawSystem = true
        break
      case "account_info":
        if (sawAccount) continue
        sawAccount = true
        break
    }

    count += 1
    ordinaryToolRun = false
  }

  return count
}

/** Replaces completed ordinary tool call/result pairs with a tiny row summary.
 * Interactive tools and incomplete live tools keep their complete payload. */
export function compactHistoricalToolEntries(entries: ReadonlyArray<TranscriptEntry>): TranscriptEntry[] {
  const completedToolIds = new Map<string, boolean>()
  const ordinaryToolIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "tool_result") completedToolIds.set(entry.toolId, Boolean(entry.isError))
    if (entry.kind === "tool_call" && !SPECIAL_TRANSCRIPT_TOOL_NAMES.has(entry.tool.toolName)) {
      ordinaryToolIds.add(entry.tool.toolId)
    }
  }

  return entries.flatMap((entry): TranscriptEntry[] => {
    if (entry.kind === "tool_result" && ordinaryToolIds.has(entry.toolId)) {
      return []
    }
    if (
      entry.kind !== "tool_call"
      || SPECIAL_TRANSCRIPT_TOOL_NAMES.has(entry.tool.toolName)
      || !completedToolIds.has(entry.tool.toolId)
    ) {
      return [entry]
    }

    const summary: ToolSummaryEntry = {
      kind: "tool_summary",
      _id: entry._id,
      messageId: entry.messageId,
      createdAt: entry.createdAt,
      hidden: entry.hidden,
      toolId: entry.tool.toolId,
      toolKind: entry.tool.toolKind,
      toolName: entry.tool.toolName,
      isError: completedToolIds.get(entry.tool.toolId) || undefined,
    }
    return [summary]
  })
}
