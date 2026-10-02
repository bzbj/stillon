import { traceAsyncAnswer } from "./asyncQuestionDiagnostics"
import type { AsyncQuestionAnswerInput, AsyncQuestionResponse } from "../../shared/types"
import type { AsyncQuestionAnswerResult } from "../../shared/protocol"
import type { StillOnSocket, SocketStatus } from "./socket"

export type Delivery = {
  chatId: string
  questionKey: string
  submissionId: string
  answers: AsyncQuestionAnswerInput[]
  status: AsyncQuestionAnswerResult["status"]
  startedAt: number
  overdue?: boolean
  checking?: boolean
  error?: string | null
}
const STORAGE = "stillon:async-question-deliveries:v1"
const keyOf = (chatId: string, questionKey: string) => JSON.stringify([chatId, questionKey])

/** Answer-only recovery. A sent command is never replayed on transport failure. */
export class AsyncQuestionDelivery {
  private version = 0
  getVersion = () => this.version
  private entries = new Map<string, Delivery>()
  private listeners = new Set<() => void>()
  private commands = new Map<string, AbortController>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  connection: SocketStatus = "disconnected"
  constructor(private socket: Pick<StillOnSocket, "command" | "onStatus">) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "[]") as Delivery[]
      for (const entry of saved) {
        this.entries.set(keyOf(entry.chatId, entry.questionKey), {
          ...entry, checking: false,
          status: entry.status === "submitting" ? "delivery_unknown" : entry.status,
        })
      }
    } catch { /* Storage unavailable: keep in-memory recovery. */ }
    socket.onStatus((status) => {
      traceAsyncAnswer("connection", { status })
      this.connection = status
      this.emit()
      if (status === "connected") {
        for (const entry of this.entries.values()) {
          if (entry.status === "submitting" || entry.status === "delivery_unknown" || entry.status === "queued") {
            void this.check(entry.chatId, entry.questionKey)
          }
        }
      }
    })
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get(chatId: string, questionKey: string) { return this.entries.get(keyOf(chatId, questionKey)) }
  private emit() {
    this.version++
    try { sessionStorage.setItem(STORAGE, JSON.stringify([...this.entries.values()])) } catch { /* best effort */ }
    for (const listener of this.listeners) listener()
  }
  private put(entry: Delivery) {
    const key = keyOf(entry.chatId, entry.questionKey)
    const prior = this.entries.get(key)
    if (!prior || prior.status !== entry.status) traceAsyncAnswer("state", { submissionId: entry.submissionId, status: entry.status, elapsedMs: Date.now() - entry.startedAt })
    this.entries.set(key, entry)
    if (entry.status === "accepted" || entry.status === "queued" || entry.status === "failed") {
      this.commands.get(key)?.abort()
      this.commands.delete(key)
    }
    if (entry.status !== "submitting") {
      clearTimeout(this.timers.get(key))
      this.timers.delete(key)
    }
    if (entry.status === "submitting" && !this.timers.has(key) && !entry.overdue) {
      this.timers.set(key, setTimeout(() => {
        this.timers.delete(key)
        const current = this.get(entry.chatId, entry.questionKey)
        if (current?.submissionId !== entry.submissionId || current.status !== "submitting") return
        this.put({ ...current, overdue: true })
        void this.check(entry.chatId, entry.questionKey)
      }, Math.max(0, 10_000 - (Date.now() - entry.startedAt))))
    }
    this.emit()
  }
  observe(chatId: string, response: AsyncQuestionResponse | AsyncQuestionAnswerResult) {
    const current = this.get(chatId, response.questionKey)
    // A delayed ACK/snapshot must not undo durable progress.
    if (current?.status === "failed" && current.submissionId === response.submissionId && response.status === "submitting") return
    if (current?.status === "accepted" && response.status !== "accepted") return
    if (current?.status === "queued" && (response.status === "submitting" || response.status === "delivery_unknown")) return
    if (current && current.submissionId !== response.submissionId && response.status === "failed") return
    const unresolved = response.status === "submitting" || response.status === "delivery_unknown"
    this.put({
      ...current, ...response, chatId,
      startedAt: current?.startedAt ?? Date.now(),
      checking: unresolved ? current?.checking ?? false : false,
      // A passive unresolved snapshot must not erase a failed query's feedback.
      // Starting a new query clears it; durable success also clears it.
      error: response.status === "failed" ? "回答未被接收，可编辑答案后重新发送。"
        : unresolved ? current?.error ?? null : null,
    })
  }
  submit(chatId: string, questionKey: string, answers: AsyncQuestionAnswerInput[], submissionId: string) {
    const prior = this.get(chatId, questionKey)
    if (prior && prior.status !== "failed") return
    const entry: Delivery = { chatId, questionKey, answers, submissionId, status: "submitting", startedAt: Date.now() }
    traceAsyncAnswer("click", { submissionId })
    this.put(entry) // synchronous guard before React renders
    const key = keyOf(chatId, questionKey)
    const controller = new AbortController()
    this.commands.set(key, controller)
    void this.socket.command<AsyncQuestionAnswerResult>({ type: "chat.answerAsyncQuestion", chatId, questionKey, answers, submissionId }, { signal: controller.signal })
      .then((result) => { traceAsyncAnswer("ack", { submissionId: result.submissionId, status: result.status }); this.observe(chatId, result) })
      .catch(() => {
        const current = this.get(chatId, questionKey)
        if (current?.submissionId === submissionId && current.status === "submitting") {
          this.put(this.connection !== "connected"
            ? { ...current, error: null }
            : { ...current, status: "delivery_unknown", error: "发送结果需要核对。" })
        }
      })
  }
  async check(chatId: string, questionKey: string) {
    const current = this.get(chatId, questionKey)
    if (!current || current.checking || current.status === "accepted" || current.status === "failed") return
    if (this.connection !== "connected") {
      this.put({ ...current, error: "暂时无法核对，请恢复连接后重试核对。" })
      return
    }
    this.put({ ...current, checking: true, error: null })
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      const result = await Promise.race([
        this.socket.command<AsyncQuestionResponse | null>({ type: "chat.getAsyncQuestionResponse", chatId, questionKey }, { signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 10_000) }),
      ])
      if (result) this.observe(chatId, result)
      else {
        const latest = this.get(chatId, questionKey)!
        if (latest.status !== "accepted" && latest.status !== "queued") {
          this.put({ ...latest, status: "delivery_unknown", checking: false, error: "服务器尚无回答记录，发送结果待核实。" })
        }
      }
    } catch {
      const latest = this.get(chatId, questionKey)!
      if (latest.status !== "accepted" && latest.status !== "queued") this.put({ ...latest, checking: false, error: "暂时无法核对，请恢复连接后重试核对。" })
    } finally {
      clearTimeout(timer); controller.abort()
      const latest = this.get(chatId, questionKey)
      if (latest?.checking) this.put({ ...latest, checking: false })
    }
  }
}

const clients = new WeakMap<StillOnSocket, AsyncQuestionDelivery>()
export function getAsyncQuestionDelivery(socket: StillOnSocket) {
  let client = clients.get(socket)
  if (!client) { client = new AsyncQuestionDelivery(socket); clients.set(socket, client) }
  return client
}
