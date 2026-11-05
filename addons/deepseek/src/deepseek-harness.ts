import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { normalizeToolCall } from "../../../src/shared/tools"
import type { AskUserQuestionItem, AskUserQuestionToolCall, DeepSeekPermissionMode, TranscriptEntry } from "../../../src/shared/types"
import type { HarnessToolRequest, HarnessTurn } from "../../../src/server/harness-types"
import { deepSeekVersion, discoverDeepSeek, killDeepSeekTree, spawnDeepSeek } from "./deepseek-cli"
import { harnessModelRoute } from "../../../src/shared/harness-models"

type Frame = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } }
const record = (value: any): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const textContent = (content: any): string => Array.isArray(content)
  ? content.filter(block => block?.type === "text").map(block => block.text ?? "").join("\n")
  : typeof content === "string" ? content : ""
type EntryInput = { [K in TranscriptEntry["kind"]]: Omit<Extract<TranscriptEntry, { kind: K }>, "_id" | "createdAt"> }[TranscriptEntry["kind"]]
const entry = (value: EntryInput): TranscriptEntry => ({ _id: randomUUID(), createdAt: Date.now(), ...value }) as TranscriptEntry

export class DeepSeekRpc {
  private serial = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private closing?: Promise<void>
  private exited: Promise<void>
  private exitConfirmed = false
  onNotification: (frame: Frame) => void = () => {}
  onRequest: (frame: Frame) => Promise<unknown> = async () => { throw new Error("No question handler") }
  onFailure: (error: Error) => void = () => {}

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise(resolve => {
      child.once("close", code => {
        this.exitConfirmed = true
        this.fail(new Error(`DeepSeek CLI exited (${code ?? "signal"}).`))
        resolve()
      })
    })
    child.once("error", () => this.fail(new Error("DeepSeek CLI could not start. Check the selected executable.")))
    child.stdin.on("error", () => this.fail(new Error("DeepSeek CLI input closed.")))
    // Never relay stderr: plugins may print private configuration or request details.
    child.stderr.resume()
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      if (buffer.length > 16 * 1024 * 1024) { this.fail(new Error("DeepSeek protocol frame exceeded the size limit.")); return }
      let end: number
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
        if (!line) continue
        let frame: Frame
        try { frame = JSON.parse(line) } catch { this.fail(new Error("DeepSeek CLI wrote invalid JSON to its SDK channel.")); continue }
        if (!record(frame)) { this.fail(new Error("Invalid DeepSeek protocol frame.")); continue }
        if (frame.id !== undefined && frame.method) {
          void this.onRequest(frame).then(result => this.write({ id: frame.id, result }),
            () => this.write({ id: frame.id, error: { code: -32603, message: "The host could not answer this request." } }))
        } else if (typeof frame.id === "number") {
          const waiting = this.pending.get(frame.id)
          if (!waiting) continue
          clearTimeout(waiting.timer); this.pending.delete(frame.id)
          if (frame.error) waiting.reject(new Error(frame.error.message ?? "DeepSeek request failed."))
          else waiting.resolve(frame.result)
        } else if (frame.method) this.onNotification(frame)
      }
    })
  }

  private write(frame: Frame) {
    if (this.closed || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n")
  }

  private fail(error: Error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.onFailure(error)
  }

  request(method: string, params?: unknown, timeout = 90_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("DeepSeek CLI is no longer running."))
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DeepSeek ${method} timed out.`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  close(): Promise<void> {
    return this.closing ??= this.dispose().catch(error => { this.closing = undefined; throw error })
  }

  private async dispose() {
    if (!this.exitConfirmed) {
      await this.request("shutdown", undefined, 1500).catch(() => undefined)
      this.child.stdin.end()
      const wait = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
        clearTimeout(timer)
      }
      await wait(6000)
      if (!this.exitConfirmed && this.child.pid) {
        await killDeepSeekTree(this.child.pid).catch(error => { if (!this.exitConfirmed) throw error })
        await wait(3000)
      }
      if (!this.exitConfirmed) throw new Error("DeepSeek has not confirmed process exit. Retry Stop before continuing this chat.")
    }
  }
}

/** Convert only user-visible committed facts; never forward request/context or request/header. */
export function deepSeekTranscript(event: any, questionToolIds?: Set<string>): TranscriptEntry[] {
  if (!record(event) || !record(event.data)) return []
  const data = event.data
  if (event.type === "assistant/message") {
    const text = textContent(data.message?.content)
    return text ? [entry({ kind: "assistant_text", text })] : []
  }
  if (event.type === "tool/call") {
    if (typeof data.name !== "string" || typeof data.callId !== "string") return []
    let input: Record<string, unknown> = {}
    try {
      const parsed = typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments
      if (record(parsed)) input = parsed
    } catch { /* Keep the tool visible even if the model produced malformed arguments. */ }
    const aliases: Record<string, string> = { read: "Read", write: "Write", edit: "Edit", bash: "Bash", pwsh: "Bash", grep: "Grep", glob: "Glob" }
    // The blocking host request renders the interactive question with its own identity.
    if (data.name === "ask_user_question") { questionToolIds?.add(data.callId); return [] }
    return [entry({ kind: "tool_call", tool: normalizeToolCall({ toolName: aliases[data.name] ?? data.name, toolId: data.callId, input }) })]
  }
  if (event.type === "tool/result") {
    const message = data.message
    const toolId = message?.toolCallId
    // The coordinator records the host question and its answer. The CLI's own
    // result uses the suppressed native call ID and would orphan history paging.
    if (typeof toolId !== "string" || questionToolIds?.has(toolId)) return []
    return [entry({ kind: "tool_result", toolId, content: textContent(message.content), isError: Boolean(message.isError) })]
  }
  return []
}

export function startDeepSeekTurn(args: {
  cwd: string; content: string; model: string; effort?: string; sessionToken: string | null
  permissionMode: DeepSeekPermissionMode; environment: NodeJS.ProcessEnv
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}, dependencies = { discover: discoverDeepSeek, version: deepSeekVersion, spawn: spawnDeepSeek }): HarnessTurn {
  let rpc: DeepSeekRpc | undefined
  let cancelled = false
  let wake: (() => void) | undefined
  const frames: Frame[] = []
  const questionToolIds = new Set<string>()
  let failure: Error | undefined
  const enqueue = (frame: Frame) => { frames.push(frame); wake?.(); wake = undefined }
  const sessionId = args.sessionToken ?? randomUUID()
  const close = async () => { if (rpc) await rpc.close() }
  return {
    provider: "deepseek",
    interrupt: async () => { cancelled = true; await close(); wake?.() },
    close,
    stream: {
      async *[Symbol.asyncIterator]() {
        const started = Date.now()
        let finalText = ""
        try {
          const executable = await dependencies.discover(args.environment)
          const version = await dependencies.version(executable, args.environment)
          if (cancelled) return
          rpc = new DeepSeekRpc(dependencies.spawn(executable, args.cwd, { ...args.environment,
            DSH_PERMISSION_MODE: args.permissionMode === "full" ? "danger-full-access" : "workspace-write",
          }))
          rpc.onNotification = enqueue
          rpc.onFailure = error => { failure = error; wake?.(); wake = undefined }
          rpc.onRequest = async frame => {
            if (cancelled) return { cancelled: true }
            const approval = frame.method === "approval/request"
            if (!approval && frame.method !== "user-question/ask") throw new Error("Unsupported DeepSeek request")
            const params = frame.params ?? {}
            const nativeQuestions = Array.isArray(params.questions) ? params.questions : []
            const questions: AskUserQuestionItem[] = approval ? [{
              id: "decision", header: "Permission", question: `Allow ${params.toolName ?? "this operation"} once?${params.reason ? `\n${params.reason}` : ""}`,
              options: [{ label: "Allow once" }, { label: "Reject" }],
            }] : nativeQuestions.map((question: any) => ({
              id: question.id, question: `${question.question ?? "DeepSeek needs your input"}${question.detail ? `\n\n${question.detail}` : ""}`,
              header: question.header, multiSelect: question.multiSelect,
              options: question.options?.map((option: any) => typeof option === "string" ? { label: option } : { label: option.label, description: option.description }),
            }))
            const tool: AskUserQuestionToolCall = { kind: "tool", toolName: "AskUserQuestion", toolKind: "ask_user_question", toolId: String(params.requestId ?? `deepseek-request-${frame.id}`), input: { questions } }
            enqueue({ method: "stillon.tool", params: tool })
            const response = await args.onToolRequest({ tool }) as { answers?: Record<string, string[]>; discarded?: boolean } | null
            if (cancelled || response?.discarded || !response?.answers || !Object.keys(response.answers).length) return approval ? { outcome: "cancelled" } : { cancelled: true }
            if (approval) return { outcome: response.answers.decision?.[0] === "Allow once" ? "allowed-once" : "rejected" }
            return { answers: nativeQuestions.map((question: any, index: number) => {
              const values = response.answers![question.id] ?? response.answers![questions[index]!.question] ?? []
              const options = question.options ?? []
              const selected = options.filter((option: any) => values.includes(typeof option === "string" ? option : option.label)).map((option: any) => typeof option === "string" ? option : option.label)
              const custom = values.filter(value => !options.some((option: any) => (typeof option === "string" ? option : option.label) === value)).join("\n")
              return { id: question.id, selected, ...(custom ? { custom } : {}) }
            }) }
          }
          const route = harnessModelRoute(args.model)
          const initialized = await rpc.request("initialize", {
            cwd: args.cwd, ...route,
            ...(args.effort && args.effort !== "default" ? { reasoningEffort: args.effort } : {}), approvalRequests: true, capabilities: { userQuestions: true },
          })
          if (initialized?.serverInfo?.name !== "deepseek-harness-sdk-runtime") throw new Error(`Unsupported DeepSeek SDK runtime (${version}).`)
          if (args.sessionToken) await rpc.request("session/resume", { sessionId })
          // The shipped SDK profile consumes DSH_PERMISSION_MODE at boot. This works
          // with Desktop 0.2.1-rc.5, which predates the session/query RPC.
          frames.length = 0
          yield { type: "session_token", sessionToken: sessionId }
          yield { type: "transcript", entry: entry({ kind: "system_init", provider: "deepseek", model: args.model, tools: [], agents: [], slashCommands: [], mcpServers: [] }) }
          const receipt = await rpc.request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: args.content }] })
          let admitted = false
          let finished = false
          let terminal: any
          while (!finished && !cancelled) {
            if (!frames.length) {
              if (failure) throw failure
              await new Promise<void>(resolve => { wake = resolve })
              continue
            }
            const frame = frames.shift()!
            if (frame.method === "stillon.tool") { yield { type: "transcript", entry: entry({ kind: "tool_call", tool: frame.params }) }; continue }
            if (frame.params?.sessionId !== sessionId) continue
            if (frame.method === "session.status") {
              if (admitted && frame.params.status === "idle") finished = true
              continue
            }
            if (frame.method !== "session.event") continue
            const event = frame.params.event
            if (event?.type === "agent/inbox/spliced" && event.data?.inserted?.some((message: any) => message.id === receipt.messageId)) admitted = true
            if (!admitted) continue
            if (event?.type === "turn/end") terminal = event.data?.reason
            for (const transcript of deepSeekTranscript(event, questionToolIds)) {
              if (transcript.kind === "assistant_text") finalText = transcript.text
              yield { type: "transcript", entry: transcript }
            }
          }
          if (!cancelled) yield { type: "transcript", entry: entry({ kind: "result", subtype: terminal?.kind === "completed" ? "success" : "error", isError: terminal?.kind !== "completed", durationMs: Date.now() - started, result: (terminal?.kind === "error" ? terminal.error?.message : finalText) || terminal?.message || terminal?.kind || "DeepSeek returned no response." }) }
        } catch (error) {
          if (!cancelled) yield { type: "transcript", entry: entry({ kind: "result", subtype: "error", isError: true, durationMs: Date.now() - started, result: error instanceof Error ? error.message : "DeepSeek Harness failed." }) }
        } finally {
          await close()
        }
      },
    },
  }
}
