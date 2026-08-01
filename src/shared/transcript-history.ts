/**
 * Visible rows in the initial chat snapshot. Hidden protocol records cost zero
 * and a consecutive run of ordinary tools costs one collapsed row.
 */
export const INITIAL_CHAT_HISTORY_ENTRY_LIMIT = 40

/**
 * UTF-8 byte budget for JSON.stringify(messages) in the initial chat snapshot.
 * A single newest entry, or an atomic tool call/result unit, may exceed this
 * soft ceiling so history pagination always makes progress.
 */
export const INITIAL_CHAT_HISTORY_SERIALIZED_BYTE_LIMIT = 512 * 1024

/**
 * Visible rows in each follow-up page.
 */
export const CHAT_HISTORY_PAGE_ENTRY_LIMIT = 60

export const CHAT_HISTORY_RAW_ENTRY_SAFETY_LIMIT = 500

export const SPECIAL_TRANSCRIPT_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])
