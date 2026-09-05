import { spawn } from "node:child_process"
import type { SpawnOptions } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type {
  CodexPermissionMode,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  ServiceTier,
  TranscriptEntry,
} from "../shared/types"
import { inheritAgentEnvironment } from "./agent-environment"
import { getCodexCliCommand } from "./codex-cli-command"
import { collectProcessTree } from "./process-tree"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"

// Grace period for the Codex process group to exit on SIGTERM before we
// escalate to SIGKILL, and how long we then wait to reap it. The two together
// stay within the cancellation budget in AgentCoordinator.cancel().
const TERMINATE_GRACE_MS = 2_000
const TERMINATE_KILL_TIMEOUT_MS = 3_000

type CodexExecPermissionMode = CodexPermissionMode | "read-only"

export function codexSpawnOptions(
  cwd: string,
  environment: NodeJS.ProcessEnv
): SpawnOptions & { detached: boolean } {
  return {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: environment,
    // Deliberately NOT detached. Staying in the server's process group is what
    // lets an external teardown — `launchctl bootout`, a tty SIGINT — reap the
    // CLI along with the server. Cancellation cannot use a group signal here
    // (that would hit the server too), so terminateChild() enumerates and
    // signals the process tree by pid instead.
    detached: false,
  }
}

export interface StartCodexExecSessionArgs {
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  permissionMode?: CodexExecPermissionMode
  ephemeral?: boolean
}

export interface StartCodexExecTurnArgs {
  chatId: string
  model: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  content: string
  planMode: boolean
  permissionMode?: CodexExecPermissionMode
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
}

export interface GenerateCodexExecStructuredArgs {
  cwd: string
  prompt: string
  model?: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  permissionMode?: CodexExecPermissionMode
  ephemeral?: boolean
  timeoutMs?: number
}

interface CodexExecProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  pid?: number
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
}

type SpawnCodexExec = (args: string[], cwd: string, environment: NodeJS.ProcessEnv) => CodexExecProcess

interface SessionContext {
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
  pendingTurn: PendingTurn | null
  permissionMode: CodexExecPermissionMode | undefined
  ephemeral: boolean
  closed: boolean
}

interface PendingTurn {
  child: CodexExecProcess
  queue: AsyncQueue<HarnessEvent>
  model: string
  startedAt: number
  stderrLines: string[]
  lastProtocolError: string | null
  startedToolIds: Set<string>
  resolved: boolean
  exited: boolean
  exitWaiters: Array<() => void>
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function codexSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "codex",
    model,
    tools: ["Bash", "Write", "Edit", "WebSearch", "TodoWrite", "AskUserQuestion", "ExitPlanMode"],
    agents: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
    slashCommands: [],
    mcpServers: [],
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

function reasoningConfig(effort?: CodexReasoningEffort) {
  return effort ? [`model_reasoning_effort="${effort}"`] : []
}

function serviceTierConfig(serviceTier?: ServiceTier) {
  return serviceTier ? [`service_tier="${serviceTier}"`] : []
}

function permissionConfig(permissionMode: CodexExecPermissionMode | undefined) {
  switch (permissionMode) {
    case "read-only":
      return [
        'sandbox_mode="read-only"',
        'approval_policy="never"',
        'approvals_reviewer="user"',
      ]
    case "request":
      return [
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="user"',
      ]
    case "auto":
      return [
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="auto_review"',
      ]
    case "full":
    default:
      return [
        'sandbox_mode="danger-full-access"',
        'approval_policy="never"',
        'approvals_reviewer="user"',
      ]
  }
}

function normalizeExecUsage(value: unknown): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens)
  const cachedInputTokens = asNumber(usage.cached_input_tokens) ?? asNumber(usage.cachedInputTokens)
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens)
  const reasoningOutputTokens =
    asNumber(usage.reasoning_output_tokens) ?? asNumber(usage.reasoningOutputTokens)
  const totalTokens = asNumber(usage.total_tokens) ?? asNumber(usage.totalTokens)
  const usedTokens = totalTokens ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  )

  if (usedTokens === undefined || usedTokens <= 0) return null

  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function commandString(item: Record<string, unknown>) {
  return asString(item.command) ?? ""
}

function commandToolCall(item: Record<string, unknown>): TranscriptEntry {
  const id = asString(item.id) ?? randomUUID()
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "bash",
      toolName: "Bash",
      toolId: id,
      input: {
        command: commandString(item),
      },
      rawInput: item,
    },
  })
}

function commandToolResult(item: Record<string, unknown>): TranscriptEntry {
  const id = asString(item.id) ?? randomUUID()
  const exitCode = asNumber(item.exit_code) ?? asNumber(item.exitCode)
  const status = asString(item.status)
  return timestamped({
    kind: "tool_result",
    toolId: id,
    content: item.aggregated_output ?? item.aggregatedOutput ?? "",
    isError: (exitCode !== undefined && exitCode !== 0) || status === "failed" || status === "declined",
  })
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ done: false, value })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }
        if (this.done) {
          return { done: true, value: undefined as never }
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

export class CodexExecManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly spawnProcess: SpawnCodexExec
  private readonly getEnvironment: () => NodeJS.ProcessEnv

  constructor(args: { spawnProcess?: SpawnCodexExec; getEnvironment?: () => NodeJS.ProcessEnv } = {}) {
    this.getEnvironment = args.getEnvironment ?? (() => inheritAgentEnvironment())
    this.spawnProcess = args.spawnProcess ?? ((commandArgs, cwd, environment) =>
      spawn(getCodexCliCommand(), commandArgs, codexSpawnOptions(cwd, environment)) as unknown as CodexExecProcess)
  }

  async startSession(args: StartCodexExecSessionArgs): Promise<string | undefined> {
    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && !args.pendingForkSessionToken) {
      existing.model = args.model
      existing.serviceTier = args.serviceTier
      existing.sessionToken = args.sessionToken
      existing.permissionMode = args.permissionMode
      existing.ephemeral = args.ephemeral ?? false
      return existing.sessionToken ?? undefined
    }

    if (existing) {
      this.stopSession(args.chatId)
    }

    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      model: args.model,
      serviceTier: args.serviceTier,
      permissionMode: args.permissionMode,
      // codex exec has exact resume, but no confirmed fork equivalent. A fork
      // request starts a fresh exec session; Kanna clears the pending fork once
      // the new thread id arrives.
      sessionToken: args.pendingForkSessionToken ? null : args.sessionToken,
      pendingTurn: null,
      closed: false,
      ephemeral: args.ephemeral ?? false,
    }
    this.sessions.set(args.chatId, context)
    return context.sessionToken ?? undefined
  }

  async startTurn(args: StartCodexExecTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("Codex exec turn is already running")
    }

    const queue = new AsyncQueue<HarnessEvent>()
    if (context.sessionToken) {
      queue.push({ type: "session_token", sessionToken: context.sessionToken })
    }

    const commandArgs = this.buildCommandArgs(context, args)
    const child = this.spawnProcess(commandArgs, context.cwd, this.getEnvironment())
    const pendingTurn: PendingTurn = {
      child,
      queue,
      model: args.model,
      startedAt: Date.now(),
      stderrLines: [],
      lastProtocolError: null,
      startedToolIds: new Set(),
      resolved: false,
      exited: false,
      exitWaiters: [],
    }
    context.pendingTurn = pendingTurn

    this.attachListeners(context, pendingTurn)

    child.stdin.write(args.content)
    if (!args.content.endsWith("\n")) {
      child.stdin.write("\n")
    }
    child.stdin.end()

    return {
      provider: "codex",
      stream: queue,
      interrupt: async () => {
        this.finishTurn(context, pendingTurn, "cancelled", "")
        await this.terminateChild(child, pendingTurn)
      },
      close: () => {
        if (!pendingTurn.resolved) {
          void this.terminateChild(child, pendingTurn)
          this.finishTurn(context, pendingTurn, "error", "Codex exec turn closed")
        }
      },
    }
  }

  async generateStructured(args: GenerateCodexExecStructuredArgs): Promise<string | null> {
    const chatId = `quick-${randomUUID()}`
    let turn: HarnessTurn | null = null
    let assistantText = ""
    let resultText = ""

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "gpt-5.6-sol",
        serviceTier: args.serviceTier,
        sessionToken: null,
        permissionMode: args.permissionMode,
        ephemeral: args.ephemeral,
      })
      turn = await this.startTurn({
        chatId,
        model: args.model ?? "gpt-5.6-sol",
        effort: args.effort,
        serviceTier: args.serviceTier,
        permissionMode: args.permissionMode,
        content: args.prompt,
        planMode: false,
        onToolRequest: async () => ({}),
      })

      const consume = async () => {
        for await (const event of turn!.stream) {
          if (event.type !== "transcript" || !event.entry) continue
          if (event.entry.kind === "assistant_text") {
            // Codex can emit short progress messages before its final answer.
            // The last completed agent message is the one-off operation result.
            assistantText = event.entry.text
          }
          if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
            resultText = event.entry.result
          }
        }
      }

      if (args.timeoutMs && args.timeoutMs > 0) {
        let timeout: ReturnType<typeof setTimeout> | null = null
        try {
          await Promise.race([
            consume(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Codex request timed out.")), args.timeoutMs)
            }),
          ])
        } catch (error) {
          await turn.interrupt()
          throw error
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      } else {
        await consume()
      }

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    } finally {
      turn?.close()
      this.stopSession(chatId)
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    context.closed = true
    if (context.pendingTurn) {
      void this.terminateChild(context.pendingTurn.child, context.pendingTurn)
      context.pendingTurn.queue.finish()
      context.pendingTurn = null
    }
    this.sessions.delete(chatId)
  }

  stopAll() {
    for (const chatId of this.sessions.keys()) {
      this.stopSession(chatId)
    }
  }

  private buildCommandArgs(context: SessionContext, args: StartCodexExecTurnArgs) {
    const configArgs = [
      ...reasoningConfig(args.effort),
      ...serviceTierConfig(args.serviceTier ?? context.serviceTier),
      ...permissionConfig(args.permissionMode ?? context.permissionMode),
    ].flatMap((config) => ["-c", config])
    if (context.sessionToken) {
      return [
        "exec",
        "resume",
        "--json",
        "-m",
        args.model,
        ...configArgs,
        "--skip-git-repo-check",
        context.sessionToken,
        "-",
      ]
    }

    return [
      "exec",
      ...(context.ephemeral ? ["--ephemeral"] : []),
      "--json",
      "-C",
      context.cwd,
      "-m",
      args.model,
      ...configArgs,
      "--skip-git-repo-check",
      "-",
    ]
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error("Codex exec session not started")
    }
    return context
  }

  private attachListeners(context: SessionContext, pendingTurn: PendingTurn) {
    const stdout = createInterface({ input: pendingTurn.child.stdout })
    void (async () => {
      for await (const line of stdout) {
        const parsed = parseJsonLine(line)
        if (!parsed) continue
        this.handleEvent(context, pendingTurn, parsed)
      }
    })()

    const stderr = createInterface({ input: pendingTurn.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) {
          pendingTurn.stderrLines.push(line.trim())
        }
      }
    })()

    pendingTurn.child.on("error", (error) => {
      this.finishTurn(context, pendingTurn, "error", error.message)
    })

    pendingTurn.child.on("close", (code) => {
      // Record the exit before the resolved-guard below: terminateChild() waits
      // on this even for turns whose stream was already finished by cancel().
      this.markExited(pendingTurn)
      // Let the readline loops consume any final buffered stdout/stderr lines
      // before selecting the terminal error message.
      queueMicrotask(() => {
        if (pendingTurn.resolved) return
        const message = pendingTurn.lastProtocolError
          || pendingTurn.stderrLines.at(-1)
          || `Codex exec exited with code ${code ?? 1}`
        this.finishTurn(context, pendingTurn, code === 0 ? "success" : "error", code === 0 ? "" : message)
      })
    })
  }

  private handleEvent(context: SessionContext, pendingTurn: PendingTurn, event: Record<string, unknown>) {
    const type = asString(event.type)

    if (type === "thread.started") {
      const threadId = asString(event.thread_id) ?? asString(event.threadId)
      if (threadId) {
        context.sessionToken = threadId
        pendingTurn.queue.push({ type: "session_token", sessionToken: threadId })
      }
      return
    }

    if (type === "turn.started") {
      pendingTurn.queue.push({ type: "transcript", entry: codexSystemInitEntry(pendingTurn.model) })
      return
    }

    if (type === "item.started") {
      this.handleItemStarted(pendingTurn, event.item)
      return
    }

    if (type === "item.completed") {
      this.handleItemCompleted(pendingTurn, event.item)
      return
    }

    if (type === "turn.completed") {
      const usage = normalizeExecUsage(event.usage)
      if (usage) {
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage,
          }),
        })
      }

      const turn = asRecord(event.turn)
      const status = asString(event.status) ?? asString(turn?.status)
      const error = asString(event.error) ?? asString(asRecord(turn?.error)?.message)
      const resultKind = status === "cancelled" || status === "interrupted"
        ? "cancelled"
        : status === "failed" || error
          ? "error"
          : "success"
      this.finishTurn(context, pendingTurn, resultKind, error ?? "")
      return
    }

    if (type === "turn.failed") {
      const message = asString(asRecord(event.error)?.message)
        ?? asString(event.message)
        ?? pendingTurn.lastProtocolError
        ?? "Codex exec turn failed"
      this.finishTurn(context, pendingTurn, "error", message)
      return
    }

    if (type === "error") {
      const message = asString(asRecord(event.error)?.message) ?? asString(event.message) ?? "Codex exec error"
      // Codex emits this event for retryable transport errors while keeping
      // the exec turn running. A terminal failure arrives later as
      // `turn.failed` or a non-zero child exit.
      pendingTurn.lastProtocolError = message
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "status",
          status: message,
        }),
      })
    }
  }

  private handleItemStarted(pendingTurn: PendingTurn, value: unknown) {
    const item = asRecord(value)
    if (!item) return
    const itemType = asString(item.type)
    if (itemType !== "command_execution") return

    const id = asString(item.id)
    if (id) {
      pendingTurn.startedToolIds.add(id)
    }
    pendingTurn.queue.push({ type: "transcript", entry: commandToolCall(item) })
  }

  private handleItemCompleted(pendingTurn: PendingTurn, value: unknown) {
    const item = asRecord(value)
    if (!item) return
    const itemType = asString(item.type)

    if (itemType === "agent_message") {
      const text = asString(item.text)
      if (text?.trim()) {
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_text",
            text,
          }),
        })
      }
      return
    }

    if (itemType === "command_execution") {
      const id = asString(item.id)
      if (id && !pendingTurn.startedToolIds.has(id)) {
        pendingTurn.startedToolIds.add(id)
        pendingTurn.queue.push({ type: "transcript", entry: commandToolCall(item) })
      }
      pendingTurn.queue.push({ type: "transcript", entry: commandToolResult(item) })
    }
  }

  private finishTurn(
    context: SessionContext,
    pendingTurn: PendingTurn,
    subtype: "success" | "error" | "cancelled",
    result: string,
  ) {
    if (pendingTurn.resolved) return
    pendingTurn.resolved = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype,
        isError: subtype === "error",
        durationMs: Date.now() - pendingTurn.startedAt,
        result,
      }),
    })
    pendingTurn.queue.finish()
    if (context.pendingTurn === pendingTurn) {
      context.pendingTurn = null
    }
  }

  private signalChild(child: CodexExecProcess, signal: NodeJS.Signals) {
    try {
      child.kill(signal)
    } catch {
      // Ignore kill failures.
    }
  }

  private markExited(pendingTurn: PendingTurn) {
    if (pendingTurn.exited) return
    pendingTurn.exited = true
    for (const waiter of pendingTurn.exitWaiters.splice(0)) {
      waiter()
    }
  }

  private waitForExit(pendingTurn: PendingTurn, timeoutMs: number): Promise<boolean> {
    if (pendingTurn.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(exited)
      }
      const timer = setTimeout(() => finish(pendingTurn.exited), timeoutMs)
      pendingTurn.exitWaiters.push(() => finish(true))
    })
  }

  private signalPid(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, or not ours to signal.
    }
  }

  private isPidAlive(pid: number) {
    try {
      // Signal 0 performs the existence check without delivering anything.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async waitForTreeExit(pids: number[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!pids.some((pid) => this.isPidAlive(pid))) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return !pids.some((pid) => this.isPidAlive(pid))
  }

  private async terminateChild(child: CodexExecProcess, pendingTurn: PendingTurn) {
    const pid = child.pid

    if (!pid || process.platform === "win32") {
      // No pid to walk from (a test double), or a platform without a POSIX
      // process tree to enumerate: fall back to signalling the child itself.
      if (pendingTurn.exited) return
      this.signalChild(child, "SIGTERM")
      if (await this.waitForExit(pendingTurn, TERMINATE_GRACE_MS)) return
      this.signalChild(child, "SIGKILL")
      await this.waitForExit(pendingTurn, TERMINATE_KILL_TIMEOUT_MS)
      return
    }

    // Snapshot the tree before signalling anything: `codex` is often a Node
    // shim, and once it exits the native binary it spawned is reparented to
    // init, losing the link we need to find it.
    const tree = await collectProcessTree(pid)
    if (pendingTurn.exited && !tree.some((entry) => this.isPidAlive(entry))) return

    // SIGTERM first so Codex can release its thread-writer lock on the way out.
    for (const entry of tree) this.signalPid(entry, "SIGTERM")
    if (await this.waitForTreeExit(tree, TERMINATE_GRACE_MS)) return

    // Something survived. SIGKILL cannot be caught or forwarded by a shim,
    // which is why every pid in the tree is targeted individually.
    for (const entry of tree) this.signalPid(entry, "SIGKILL")
    await this.waitForTreeExit(tree, TERMINATE_KILL_TIMEOUT_MS)
  }
}
