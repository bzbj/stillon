import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { normalizeToolCall } from "../../../src/shared/tools"
import type { AskUserQuestionItem, AskUserQuestionToolCall, TranscriptEntry } from "../../../src/shared/types"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "../../../src/server/harness-types"
import { checkCodeBuddy, killCodeBuddyTree, spawnCodeBuddy } from "./codebuddy-cli"

const record = (v: any): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v))
const contentText = (v: any): string => typeof v === "string" ? v : Array.isArray(v) ? v.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n") : ""
type EntryInput = { [K in TranscriptEntry["kind"]]: Omit<Extract<TranscriptEntry, { kind: K }>, "_id" | "createdAt"> }[TranscriptEntry["kind"]]
const entry = (v: EntryInput): TranscriptEntry => ({ _id: randomUUID(), createdAt: Date.now(), ...v }) as TranscriptEntry

/** A single public CLI process, speaking the documented SDK stream-json protocol. */
export class CodeBuddyProtocol {
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private failure?: Error
  private exited = false
  private exitPromise: Promise<void>
  private closing?: Promise<void>
  onFrame: (frame: any) => void = () => {}
  onRequest: (request: any, id: string) => Promise<unknown> = async () => ({ allowed: false, reason: "No handler" })
  onFailure: (error: Error) => void = () => {}
  sessionId?: string

  constructor(private child: ChildProcessWithoutNullStreams) {
    this.exitPromise = new Promise(resolve => child.once("close", () => { this.exited = true; this.fail(new Error("CodeBuddy CLI exited before the turn completed.")); resolve() }))
    child.once("error", () => this.fail(new Error("CodeBuddy CLI could not start.")))
    child.stdin.on("error", () => this.fail(new Error("CodeBuddy CLI input closed.")))
    // Account tokens can appear in initialization and diagnostics. Never relay raw frames or stderr.
    child.stderr.resume()
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (this.failure) return
      buffer += chunk
      if (buffer.length > 16 * 1024 * 1024) { this.fail(new Error("CodeBuddy protocol frame exceeded the size limit.")); return }
      let end: number
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
        if (!line) continue
        let frame: any
        try { frame = JSON.parse(line); if (!record(frame)) throw new Error() }
        catch { this.fail(new Error("CodeBuddy CLI returned invalid stream-json.")); return }
        if (frame.type === "control_response") {
          const response = frame.response, waiting = this.pending.get(response?.request_id)
          if (!waiting) continue
          clearTimeout(waiting.timer); this.pending.delete(response.request_id)
          if (response.subtype === "success") waiting.resolve(response.response)
          else waiting.reject(new Error("CodeBuddy CLI rejected a control request. Check CLI compatibility and sign-in."))
        } else if (frame.type === "control_request" && typeof frame.request_id === "string") {
          void this.onRequest(frame.request, frame.request_id).then(response => this.reply(frame.request_id, response),
            () => this.reply(frame.request_id, { allowed: false, reason: "The host could not answer this request." }))
        } else {
          if (frame.type === "system" && frame.subtype === "init" && typeof frame.session_id === "string") this.sessionId = frame.session_id
          this.onFrame(frame)
        }
      }
    })
  }
  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear(); this.onFailure(error)
  }
  write(frame: unknown) { if (!this.exited && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.write(JSON.stringify(frame) + "\n") }
  private reply(id: string, response: unknown) { this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } }) }
  request(request: Record<string, unknown>, timeout = 30_000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CodeBuddy ${request.subtype} timed out.`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer }); this.write({ type: "control_request", request_id: id, request })
    })
  }
  close() { return this.closing ??= this.dispose().catch(error => { this.closing = undefined; throw error }) }
  private async dispose() {
    if (this.exited) return
    // Interrupt the session before EOF; an ACK alone never confirms process exit.
    await this.request({ subtype: "interrupt", session_id: this.sessionId, reason: "StillOn turn closed" }, 1500).catch(() => undefined)
    this.child.stdin.end()
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]); clearTimeout(timer)
    }
    await wait(4000)
    if (!this.exited && this.child.pid) {
      await killCodeBuddyTree(this.child.pid).catch(error => { if (!this.exited) throw error })
      await wait(2000)
    }
    if (!this.exited) throw new Error("CodeBuddy has not confirmed process exit. Retry Stop before continuing.")
  }
}

/** Deliberately ignores init account fields, raw control messages and history replay. */
export function codeBuddyTranscript(frame: any): TranscriptEntry[] {
  if (!record(frame) || !Array.isArray(frame.message?.content)) return []
  const entries: TranscriptEntry[] = []
  for (const block of frame.message.content) {
    if (frame.type === "assistant" && block?.type === "text" && typeof block.text === "string") entries.push(entry({ kind: "assistant_text", text: block.text }))
    if (frame.type === "assistant" && block?.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string" && block.name !== "AskUserQuestion") {
      entries.push(entry({ kind: "tool_call", tool: normalizeToolCall({ toolName: block.name, toolId: block.id, input: record(block.input) ? block.input : {} }) }))
    }
    if (frame.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") entries.push(entry({ kind: "tool_result", toolId: block.tool_use_id, content: contentText(block.content), isError: Boolean(block.is_error) }))
  }
  return entries
}

export type CodeBuddyTurnArgs = {
  cwd: string; content: string; model: string; effort?: string; sessionToken: string | null
  permissionMode: "request" | "full"; environment: NodeJS.ProcessEnv
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}
export function codeBuddyArgs(args: Omit<CodeBuddyTurnArgs, "onToolRequest" | "environment">) {
  // Public Windows npm launchers cross cmd.exe. Keep option values literal even
  // when a saved session ID or a package's model descriptor is malformed.
  if (!/^[A-Za-z0-9_.:@/+\-]{1,128}$/u.test(args.model)) throw new Error("Invalid CodeBuddy model identifier.")
  if (args.sessionToken && !/^[A-Za-z0-9_-]{1,128}$/u.test(args.sessionToken)) throw new Error("Invalid CodeBuddy session identifier.")
  if (args.effort && !["default", "low", "medium", "high", "xhigh"].includes(args.effort)) throw new Error("Invalid CodeBuddy reasoning effort.")
  const result = ["--print", "--input-format=stream-json", "--output-format=stream-json", "--verbose", "--setting-sources", "user,project,local", "--permission-mode", args.permissionMode === "full" ? "bypassPermissions" : "default"]
  if (args.model !== "default") result.push("--model", args.model)
  if (args.effort && args.effort !== "default") result.push("--effort", args.effort)
  if (args.sessionToken) result.push("--resume", args.sessionToken)
  return result
}

export function startCodeBuddyTurn(args: CodeBuddyTurnArgs, dependencies = { check: checkCodeBuddy, spawn: spawnCodeBuddy }): HarnessTurn {
  let protocol: CodeBuddyProtocol | undefined, cancelled = false, failure: Error | undefined, wake: (() => void) | undefined
  const frames: any[] = [], activeTasks = new Set<string>()
  const enqueue = (frame: any) => { frames.push(frame); wake?.(); wake = undefined }
  const close = async () => { if (protocol) await protocol.close() }
  return { provider: "codebuddy", close, interrupt: async () => { cancelled = true; wake?.(); await close() }, stream: {
    async *[Symbol.asyncIterator](): AsyncGenerator<HarnessEvent> {
      const started = Date.now()
      try {
        const { executable } = await dependencies.check(args.environment)
        if (cancelled) return
        protocol = new CodeBuddyProtocol(dependencies.spawn(executable, codeBuddyArgs(args), args.cwd, args.environment))
        protocol.onFrame = enqueue
        protocol.onFailure = error => { failure = error; wake?.(); wake = undefined }
        protocol.onRequest = async (request, id) => {
          const deny = { allowed: false, reason: "User did not approve this operation.", tool_use_id: request?.tool_use_id }
          if (cancelled) return deny
          if (request?.subtype === "elicitation_create") return { action: "cancel" }
          if (request?.subtype !== "can_use_tool") return deny
          const input = record(request.input) ? request.input : {}, asking = request.tool_name === "AskUserQuestion"
          const questions: AskUserQuestionItem[] = asking && Array.isArray(input.questions) ? input.questions.filter((q: any) => typeof q?.question === "string").map((q: any, index: number) => ({ ...q, id: String(index) }))
            : [{ id: "decision", header: "Permission", question: `Allow ${request.tool_name ?? "this operation"} once?\n${JSON.stringify(input, null, 2).slice(0, 8000)}`, options: [{ label: "Allow once" }, { label: "Reject" }] }]
          if (!questions.length) return deny
          const tool: AskUserQuestionToolCall = { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: `codebuddy-request-${id}`, input: { questions } }
          enqueue({ type: "stillon_question", tool })
          const response = await args.onToolRequest({ tool }) as { discarded?: boolean; answers?: Record<string, string[]> } | null
          if (cancelled || response?.discarded || !record(response?.answers)) return deny
          if (!asking) return response.answers.decision?.[0] === "Allow once" ? { allowed: true, updatedInput: input, tool_use_id: request.tool_use_id } : deny
          const answers: Record<string, string> = {}
          for (const q of questions) {
            const values = response.answers[q.id!] ?? response.answers[q.question]
            if (!Array.isArray(values) || !values.length || !values.every(v => typeof v === "string")) return deny
            answers[q.question] = values.join(", ")
          }
          return { allowed: true, updatedInput: { ...input, answers }, tool_use_id: request.tool_use_id }
        }
        // Do not retain or forward this response: it can contain account.token.
        await protocol.request({ subtype: "initialize", hooks: {}, capabilities: { askUserQuestion: true }, hasPrompt: true })
        if (cancelled) return
        protocol.write({ type: "user", session_id: "", message: { role: "user", content: args.content }, parent_tool_use_id: null })
        let terminal: any, finalText = ""
        while (!cancelled) {
          if (!frames.length) {
            if (terminal && !activeTasks.size) break
            if (failure) throw failure
            await new Promise<void>(resolve => { wake = resolve }); continue
          }
          const frame = frames.shift()!
          if (frame.type === "system" && frame.subtype === "init") {
            if (typeof frame.session_id !== "string" || !frame.session_id) throw new Error("CodeBuddy returned no session identity.")
            if (args.sessionToken && args.sessionToken !== frame.session_id) throw new Error("CodeBuddy did not resume the requested session. Start a new chat instead.")
            yield { type: "session_token", sessionToken: frame.session_id }
            yield { type: "transcript", entry: entry({ kind: "system_init", provider: "codebuddy", model: typeof frame.model === "string" ? frame.model : args.model, tools: [], agents: [], slashCommands: [], mcpServers: [] }) }
          }
          if (frame.type === "system" && frame.subtype === "task_started" && typeof frame.task_id === "string") activeTasks.add(frame.task_id)
          if (frame.type === "system" && frame.subtype === "task_notification") activeTasks.delete(frame.task_id)
          if (frame.type === "stillon_question") yield { type: "transcript", entry: entry({ kind: "tool_call", tool: frame.tool }) }
          for (const transcript of codeBuddyTranscript(frame)) {
            if (transcript.kind === "assistant_text") finalText = transcript.text
            yield { type: "transcript", entry: transcript }
          }
          if (frame.type === "result") terminal = frame
        }
        if (!cancelled) yield { type: "transcript", entry: entry({ kind: "result", subtype: terminal?.is_error || terminal?.subtype !== "success" ? "error" : "success",
          isError: Boolean(terminal?.is_error || terminal?.subtype !== "success"), durationMs: Date.now() - started,
          result: typeof terminal?.result === "string" ? terminal.result : finalText || "CodeBuddy returned no response. Check the CLI sign-in and configuration." }) }
      } catch (error) {
        if (!cancelled) yield { type: "transcript", entry: entry({ kind: "result", subtype: "error", isError: true, durationMs: Date.now() - started, result: error instanceof Error ? error.message : "CodeBuddy failed." }) }
      } finally { await close() }
    },
  } }
}
