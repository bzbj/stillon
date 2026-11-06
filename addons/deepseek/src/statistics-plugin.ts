/** Runs inside the user's DSH SDK runtime. Values come from its original projections. */
export const name = "stillon-session-statistics"
export const inject = ["sessionProjections", "sdkSessionActivation"]
interface Session { id: string }
interface Context {
  sessionProjections: {
    snapshot(session: Session, keys?: string[]): { values: Record<string, unknown> }
    onChanged(listener: (session: Session, key: string) => void): () => void
  }
  on(name: "session/event", listener: (session: Session) => void): () => void
}
export function apply(ctx: Context) {
  const seen = new Map<string, string>()
  const publish = (session: Session) => {
    if (session.id !== process.env.STILLON_DSH_STATISTICS_SESSION_ID) return
    const { values } = ctx.sessionProjections.snapshot(session, ["tokenUsage", "sessionStats"])
    if (!values.tokenUsage || !values.sessionStats) return
    const signature = JSON.stringify([values.tokenUsage, values.sessionStats])
    if (seen.get(session.id) === signature) return
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "stillon.statistics", params: {
      sessionId: session.id, statistics: { tokenUsage: values.tokenUsage, sessionStats: values.sessionStats },
    } }) + "\n")
    seen.set(session.id, signature)
  }
  ctx.sessionProjections.onChanged((session, key) => {
    if (key === "tokenUsage" || key === "sessionStats") publish(session)
  })
  ctx.on("session/event", session => { if (!seen.has(session.id)) publish(session) })
}
