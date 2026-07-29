/**
 * Initial chat snapshots are intentionally small because every subscription
 * serializes, transfers, parses, and hydrates this window before the chat is
 * interactive. The server also clamps older clients to this requested entry
 * ceiling; one newest atomic tool unit can exceed it to preserve continuity.
 */
export const INITIAL_CHAT_HISTORY_ENTRY_LIMIT = 40

/**
 * UTF-8 byte budget for JSON.stringify(messages) in the initial chat snapshot.
 * A single newest entry, or an atomic tool call/result unit, may exceed this
 * soft ceiling so history pagination always makes progress.
 */
export const INITIAL_CHAT_HISTORY_SERIALIZED_BYTE_LIMIT = 512 * 1024

/**
 * Follow-up pages are explicit, incremental requests. Keeping them modest
 * avoids replacing the initial-window win with one very large older page.
 */
export const CHAT_HISTORY_PAGE_ENTRY_LIMIT = 60
