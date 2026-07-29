import type { StandaloneTranscriptBundle, TranscriptEntry } from "./types"

export const INCOMPLETE_TOOL_RESULT_EXPORT_MESSAGE =
  "Standalone transcripts require complete tool-result content."

export function assertCompleteToolResultContent(
  messages: readonly TranscriptEntry[],
) {
  if (
    messages.some((entry) => (
      entry.kind === "tool_result"
      && entry.deferredContent !== undefined
    ))
  ) {
    throw new Error(INCOMPLETE_TOOL_RESULT_EXPORT_MESSAGE)
  }
}

export function assertCompleteStandaloneTranscript(
  bundle: Pick<StandaloneTranscriptBundle, "messages" | "toolResultContent">,
) {
  if (
    bundle.toolResultContent !== undefined
    && bundle.toolResultContent !== "complete"
  ) {
    throw new Error(INCOMPLETE_TOOL_RESULT_EXPORT_MESSAGE)
  }
  assertCompleteToolResultContent(bundle.messages)
}
