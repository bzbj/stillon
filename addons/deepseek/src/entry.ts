import { createInterface } from "node:readline"
import { startDeepSeekTurn } from "./deepseek-harness"
import { deepSeekCliVersion, discoverDeepSeek, deepSeekVersion } from "./deepseek-cli"
import type { HarnessTurn } from "../../../src/server/harness-types"
import type { AddonTurnArgs } from "../../../src/server/addon-process"
import { modelControl } from "./model-control"

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const questions = new Map<number, (answer: unknown) => void>()
let turn: HarnessTurn | undefined, serial = 0, stopping = false
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
async function checkCli() {
  const executable = await discoverDeepSeek(process.env), version = await deepSeekVersion(executable, process.env)
  // New vendor releases need qualification; a similar executable name is insufficient.
  if (version !== deepSeekCliVersion()) throw new Error(`DeepSeek CLI ${version} is not qualified by this add-on. This platform's preview requires ${deepSeekCliVersion()}.`)
  return { executable, version }
}
async function shutdown() {
  stopping = true
  for (const answer of questions.values()) answer({ discarded: true })
  questions.clear()
  if (turn) await turn.interrupt()
}
async function handle(method: string, params: any) {
  if (method === "hello") {
    if (params?.api !== 1) throw new Error("Unsupported host API.")
    return { api: 1, id: "deepseek", version: "0.2.0-preview.4" }
  }
  if (method === "status") {
    const base = { provider: "deepseek", platform: process.platform, canOpenTerminal: false, canSelectExecutable: Boolean(params?.local) }
    try { return { ...base, ...await checkCli(), installed: true, state: "ready", message: "Uses your local DeepSeek Harness. Configure model services and discover models below. Account access is checked when sending a message." } }
    catch (error) { return { ...base, installed: false, state: "error", message: error instanceof Error ? error.message : "Harness check failed." } }
  }
  if (["configuration", "discover", "configure", "fetchModels"].includes(method)) {
    const { executable } = await checkCli()
    return modelControl(executable, process.env, method, params)
  }
  if (method === "start") {
    if (turn || stopping) throw new Error("This add-on process already owns a turn.")
    if (typeof params?.cwd !== "string" || typeof params?.content !== "string" || !["request", "full"].includes(params?.permissionMode)) throw new Error("Invalid turn input.")
    await checkCli()
    if (stopping) throw new Error("Turn was stopped before startup.")
    turn = startDeepSeekTurn({ ...params as AddonTurnArgs, permissionMode: params.permissionMode, environment: process.env,
      onToolRequest: request => new Promise(resolve => { const id = ++serial; questions.set(id, resolve); send({ question: request, questionId: id }) }) })
    void (async () => {
      try { for await (const event of turn!.stream) send({ event }) }
      catch { send({ event: { type: "transcript", entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "result", subtype: "error", isError: true, result: "DeepSeek add-on failed to finish the turn." } } }) }
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
