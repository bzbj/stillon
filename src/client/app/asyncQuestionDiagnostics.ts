/** Opt-in metadata only; never include question keys, text, answers or errors. */
export function traceAsyncAnswer(stage: string, metadata: { submissionId?: string; commandId?: string; status?: string; elapsedMs?: number }) {
  try {
    if (sessionStorage.getItem("stillon:debug-async-answers") !== "1") return
    console.debug("[stillon/async-answer]", { stage, ...metadata })
  } catch { /* debug storage unavailable */ }
}
