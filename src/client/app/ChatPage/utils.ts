import type { ResolvedTranscriptRow } from "../StillOnTranscript"

export const EMPTY_STATE_TEXT = "What are we working on?"
export const EMPTY_STATE_TYPING_INTERVAL_MS = 19
export const CHAT_NAVBAR_OFFSET_PX = 72
export const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 12
export const CHAT_SELECTION_AUTOFOLLOW_WINDOW_MS = 600

export function shouldAutoFollowTranscriptResize(
  showScrollButton: boolean,
  selectionAutoFollowUntil: number,
  now = Date.now()
) {
  return !showScrollButton || now < selectionAutoFollowUntil
}

export function isInteractiveTranscriptRow(row: ResolvedTranscriptRow) {
  return row.kind === "single"
    && row.message.kind === "tool"
    && (
      row.message.toolKind === "ask_user_question"
      || row.message.toolKind === "exit_plan_mode"
      || row.message.toolKind === "todo_write"
    )
}

export function estimateTranscriptRowHeight(row: ResolvedTranscriptRow) {
  if (row.kind === "tool-group") {
    return 160
  }
  switch (row.message.kind) {
    case "compact_boundary":
    case "context_cleared":
    case "status":
      return 40
    default:
      return 96
  }
}

export function getPinnedTailStartIndex(rows: ResolvedTranscriptRow[], isProcessing: boolean) {
  let tailStartIndex = Math.max(0, rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS)

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row) continue
    if (isInteractiveTranscriptRow(row)) {
      tailStartIndex = Math.min(tailStartIndex, index)
      continue
    }
    if (index < tailStartIndex) {
      break
    }
  }

  if (!isProcessing) {
    return tailStartIndex
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row || row.kind !== "single") continue
    if (row.message.kind === "user_prompt") {
      return Math.min(tailStartIndex, index)
    }
    if (row.message.kind === "assistant_text") {
      break
    }
  }

  return tailStartIndex
}

export function hasFileDragTypes(types: Iterable<string>) {
  return Array.from(types).includes("Files")
}
