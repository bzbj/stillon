import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessEvent {
  type: "transcript" | "session_token"
  entry?: TranscriptEntry
  sessionToken?: string
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
}

export interface HarnessTurn {
  provider: AgentProvider
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  /**
   * Stop the run. Resolves once the provider confirms the run is gone and
   * rejects when that cannot be confirmed, so callers keep the chat blocked
   * rather than resuming over a live thread writer. Safe to call again to
   * retry a failed stop.
   */
  interrupt: () => Promise<void>
  /**
   * Release the run after its stream ended, or abandon it. Idempotent. When a
   * promise is returned it settles once the provider process has exited; a
   * delivered result alone does not mean the process is gone.
   */
  close: () => void | Promise<void>
}
