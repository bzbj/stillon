import { createInterface } from "node:readline"
import { startCodeBuddyTurn } from "./codebuddy-harness"
import { checkCodeBuddy } from "./codebuddy-cli"
import type { HarnessTurn } from "../../../src/server/harness-types"
import type { AddonTurnArgs } from "../../../src/server/addon-process"

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const questions = new Map<number, (answer: unknown) => void>()
let turn: HarnessTurn | undefined, serial = 0, stopping = false
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const checkCli = () => checkCodeBuddy(process.env)
async function shutdown() {
  stopping = true
  for (const answer of questions.values()) answer({ discarded: true })
  questions.clear()
  if (turn) await turn.interrupt()
}
async function handle(method: string, params: any) {
  if (method === "hello") {
    if (params?.api !== 1) throw new Error("Unsupported host API.")
    return { api: 1, id: "codebuddy", version: "0.1.0-preview.2" }
  }
  if (method === "status") {
    const base = { provider: "codebuddy", platform: process.platform, canOpenTerminal: false, canSelectExecutable: Boolean(params?.local) }
    try { return { ...base, ...await checkCli(), installed: true, state: "ready", message: "Uses the model, endpoint and credentials configured in your local CodeBuddy CLI. Account access is checked when sending a message." } }
    catch (error) { return { ...base, installed: false, state: "error", message: error instanceof Error ? error.message : "CodeBuddy check failed." } }
  }
  if (method === "start") {
    if (turn || stopping) throw new Error("This add-on process already owns a turn.")
    if (typeof params?.cwd !== "string" || typeof params?.content !== "string" || !["request", "full"].includes(params?.permissionMode)) throw new Error("Invalid turn input.")
    if (stopping) throw new Error("Turn was stopped before startup.")
    turn = startCodeBuddyTurn({ ...params as AddonTurnArgs, permissionMode: params.permissionMode, environment: process.env,
      onToolRequest: request => new Promise(resolve => { const id = ++serial; questions.set(id, resolve); send({ question: request, questionId: id }) }) })
    void (async () => {
      try { for await (const event of turn!.stream) send({ event }) }
      catch { send({ event: { type: "transcript", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "result", subtype: "error", isError: true, result: "CodeBuddy add-on failed to finish the turn." } } }) }
      finally { send({ done: true }) }
    })()
    return { started: true }
  }
  if (method === "answer") { questions.get(params?.id)?.(params?.answer); questions.delete(params?.id); return { ok: true } }
  if (method === "shutdown") { await shutdown(); return { stopped: true } }
  throw new Error("Unsupported add-on request.")
}
lines.on("line", line => {
  let frame: any
  try { frame = JSON.parse(line) } catch { process.exitCode = 1; lines.close(); return }
  void handle(frame.method, frame.params).then(result => send({ id: frame.id, result }),
    error => send({ id: frame.id, error: error instanceof Error ? error.message : "Add-on request failed." }))
})
lines.on("close", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })
