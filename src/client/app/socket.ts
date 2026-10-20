import { ConfirmedCommandError } from "./quickCommandDelivery"
import { ChatStreamDecoder, type ChatStreamFrame } from "../../shared/chat-stream"
import { receiveCodexModelPolicy } from "../stores/codexModelPolicyStore"
import { traceAsyncAnswer } from "./asyncQuestionDiagnostics"
import type {
  ClientCommand,
  ClientEnvelope,
  ServerEnvelope,
  SubscriptionTopic,
  TerminalEvent,
  TerminalSnapshot,
} from "../../shared/protocol"
import { LOG_PREFIX } from "../../shared/branding"
import { generateUUID } from "../lib/utils"
import { isConnectBrowser } from "../lib/remoteSession"
import { SocketTransport, SOCKET_TRANSPORT_QUERY } from "../../shared/socket-transport"

type SnapshotListener<T> = (value: T) => void
type EventListener<T> = (value: T) => void
export type SocketStatus = "connecting" | "connected" | "disconnected"
type StatusListener = (status: SocketStatus) => void

const STALE_CONNECTION_MS = 25_000
const HEARTBEAT_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 4_000
const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "kanna:profile-send-to-starting"

interface SubscriptionEntry<TSnapshot, TEvent = never> {
  topic: SubscriptionTopic
  chatStream?: ChatStreamDecoder
  listener: SnapshotListener<TSnapshot>
  eventListener?: EventListener<TEvent>
}

function isSendToStartingProfilingEnabled() {
  try {
    return window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
      || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export class StillOnSocket {
  private readonly url: string
  private readonly remote: boolean
  private ws: WebSocket | null = null
  private transport: SocketTransport | null = null
  private started = false
  private reconnectTimer: number | null = null
  private reconnectDelayMs = 750
  private readonly subscriptions = new Map<string, SubscriptionEntry<unknown, unknown>>()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly outboundQueue: ClientEnvelope[] = []
  private readonly statusListeners = new Set<StatusListener>()
  private heartbeatTimer: number | null = null
  private pingTimeoutTimer: number | null = null
  private pingPromise: Promise<void> | null = null
  private lastOpenAt = 0
  private lastMessageAt = 0
  private reconnectImmediatelyOnClose = false
  private readonly handleWindowFocus = () => {
    void this.ensureHealthyConnection()
  }
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.startHeartbeat()
      void this.ensureHealthyConnection()
      return
    }
    this.stopHeartbeat()
  }
  private readonly handleOnline = () => {
    void this.ensureHealthyConnection()
  }

  constructor(url: string) {
    this.url = url
    this.remote = isConnectBrowser()
  }

  start() {
    if (this.started) {
      return
    }
    this.started = true
    window.addEventListener("focus", this.handleWindowFocus)
    window.addEventListener("online", this.handleOnline)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.connect()
  }

  dispose() {
    this.started = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    this.clearPingState()
    window.removeEventListener("focus", this.handleWindowFocus)
    window.removeEventListener("online", this.handleOnline)
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.ws?.close()
    this.transport?.dispose()
    this.ws = null
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Socket disposed"))
    }
    this.pending.clear()
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.getStatus())
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  subscribe<TSnapshot, TEvent = never>(
    topic: SubscriptionTopic,
    listener: SnapshotListener<TSnapshot>,
    eventListener?: EventListener<TEvent>
  ) {
    const id = generateUUID()
    if (topic.type === "chat") topic = { ...topic, streamVersion: 1, streamId: generateUUID() }
    this.subscriptions.set(id, {
      topic,
      ...(topic.type === "chat" ? { chatStream: new ChatStreamDecoder(topic.streamId!) } : {}),
      listener: listener as SnapshotListener<unknown>,
      eventListener: eventListener as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  subscribeTerminal(
    terminalId: string,
    handlers: {
      onSnapshot: SnapshotListener<TerminalSnapshot | null>
      onEvent?: EventListener<TerminalEvent>
    }
  ) {
    const id = generateUUID()
    const topic: SubscriptionTopic = { type: "terminal", terminalId }
    this.subscriptions.set(id, {
      topic,
      listener: handlers.onSnapshot as SnapshotListener<unknown>,
      eventListener: handlers.onEvent as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  command<TResult = unknown>(command: ClientCommand, options?: { signal?: AbortSignal; operationId?: string }) {
    if (this.remote && this.ws?.readyState !== WebSocket.OPEN) return Promise.reject<TResult>(new ConfirmedCommandError("Not connected. The command was not sent. Reconnect and try again."))
    const id = options?.operationId ?? (this.remote ? `${Date.now()}-${generateUUID()}` : generateUUID())
    const envelope: ClientEnvelope = { v: 1, type: "command", id, command }
    return new Promise<TResult>((resolve, reject) => {
      const signal = options?.signal
      const abort = () => {
        this.pending.delete(id)
        const index = this.outboundQueue.findIndex((entry) => entry.id === id)
        if (index >= 0) this.outboundQueue.splice(index, 1)
        reject(new Error("Command cancelled"))
      }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener("abort", abort, { once: true })
      const cleanup = () => signal?.removeEventListener("abort", abort)
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as TResult) },
        reject: (error) => {
          // A disconnect rejects the waiter but retains unsent envelopes.
          // Keep answer-only cancellation attached until that queue is resolved.
          if (!this.outboundQueue.some((entry) => entry.id === id)) cleanup()
          reject(error)
        },
      })
      this.enqueue(envelope)
    })
  }

  ensureHealthyConnection() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.reconnectNow()
      return Promise.resolve()
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return Promise.resolve()
    }

    if (!this.isConnectionStale()) {
      return Promise.resolve()
    }

    return this.sendPing()
  }

  private resetChatStream(subscription: SubscriptionEntry<unknown, unknown>) {
    if (subscription.topic.type !== "chat") return
    const streamId = generateUUID()
    subscription.topic = { ...subscription.topic, streamVersion: 1, streamId }
    subscription.chatStream = new ChatStreamDecoder(streamId)
  }

  private connect() {
    if (!this.started) {
      return
    }
    this.emitStatus("connecting")
    this.transport?.dispose()
    const url = new URL(this.url)
    url.searchParams.set(SOCKET_TRANSPORT_QUERY, "1")
    this.ws = new WebSocket(url.href)
    const connection = this.ws
    const transport = new SocketTransport({
      write: frame => { if (connection.readyState !== WebSocket.OPEN) return false; connection.send(frame); return true },
      fail: reason => connection.close(1013, reason),
      // Only needed if a large command precedes every subscription/response.
      // Old servers answer this ordinary protocol-1 ping and select legacy mode.
      probe: () => connection.send(JSON.stringify({ v: 1, type: "command", id: "transport-probe", command: { type: "system.ping" } })),
    })
    this.transport = transport

    this.ws.addEventListener("open", () => {
      if (this.ws !== connection) return
      this.reconnectDelayMs = 750
      this.reconnectImmediatelyOnClose = false
      this.lastOpenAt = Date.now()
      this.lastMessageAt = this.lastOpenAt
      this.emitStatus("connected")
      this.startHeartbeat()
      for (const [id, subscription] of this.subscriptions.entries()) {
        this.resetChatStream(subscription)
        this.sendNow({ v: 1, type: "subscribe", id, topic: subscription.topic })
      }
      while (this.outboundQueue.length > 0) {
        const envelope = this.outboundQueue.shift()
        if (envelope?.type === "command") {
          this.sendNow(envelope)
        }
      }
    })

    this.ws.addEventListener("message", (event) => {
      if (this.ws !== connection) return
      this.lastMessageAt = Date.now()
      const receivedAt = performance.now()
      const rawText = transport.receive(String(event.data))
      if (rawText === null) return
      let payload: ServerEnvelope
      try {
        payload = JSON.parse(rawText) as ServerEnvelope
      } catch {
        return
      }

      if (payload.codexModelPolicy) {
        try {
          receiveCodexModelPolicy(payload.codexModelPolicy)
        } catch (error) {
          console.error(LOG_PREFIX, "Rejected server model catalog", error)
          return
        }
      }

      const payloadBytes = isSendToStartingProfilingEnabled()
        ? new TextEncoder().encode(rawText).byteLength
        : 0
      if (isSendToStartingProfilingEnabled() && payload.type === "snapshot" && payload.snapshot.type === "chat" && payload.snapshot.data?.runtime.status === "starting") {
        console.debug("[stillon/send->starting][client-ws]", {
          stage: "socket_message_received",
          receivedAt,
          payloadBytes,
          chatId: payload.snapshot.data.runtime.chatId,
          status: payload.snapshot.data.runtime.status,
          messageCount: payload.snapshot.data.messages.length,
        })
      }

      if (isSendToStartingProfilingEnabled() && payload.type === "ack") {
        console.debug("[stillon/send->starting][client-ws]", {
          stage: "socket_ack_received",
          receivedAt,
          payloadBytes,
          commandId: payload.id,
        })
      }

      if (payload.type === "chat-delta" || (payload.type === "snapshot" && payload.snapshot.type === "chat" && payload.stream)) {
        const subscription = this.subscriptions.get(payload.id)
        if (!subscription?.chatStream) return
        const frame: ChatStreamFrame = payload.type === "chat-delta" ? payload : {
          type: "snapshot", data: payload.snapshot.data as import("../../shared/types").ChatSnapshot | null, stream: payload.stream!,
        }
        const result = subscription.chatStream.receive(frame)
        if (result.kind === "apply") subscription.listener(result.snapshot)
        else if (result.kind === "resync") {
          this.resetChatStream(subscription)
          this.enqueue({ v: 1, type: "subscribe", id: payload.id, topic: subscription.topic })
        }
        return
      }

      if (payload.type === "snapshot") {
        const subscription = this.subscriptions.get(payload.id)
        subscription?.listener(payload.snapshot.data)
        return
      }

      if (payload.type === "event") {
        const subscription = this.subscriptions.get(payload.id)
        subscription?.eventListener?.(payload.event)
        return
      }

      if (payload.type === "ack") {
        const pending = this.pending.get(payload.id)
        if (!pending) return
        this.pending.delete(payload.id)
        pending.resolve(payload.result)
        return
      }

      if (payload.type === "error") {
        if (!payload.id) {
          console.error(LOG_PREFIX, payload.message)
          return
        }
        const pending = this.pending.get(payload.id)
        if (!pending) return
        this.pending.delete(payload.id)
        pending.reject(new ConfirmedCommandError(payload.message))
      }
    })

    this.ws.addEventListener("close", () => {
      if (this.ws !== connection) return
      transport.dispose()
      if (!this.started) {
        return
      }
      const reconnectImmediately = this.reconnectImmediatelyOnClose
      this.reconnectImmediatelyOnClose = false
      this.stopHeartbeat()
      this.clearPingState()
      this.emitStatus("disconnected")
      if (this.remote) this.outboundQueue.length = 0
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(this.remote ? `连接中断，结果尚未确认。请先查看任务状态，勿重复提交。（操作 ${id}）` : "Disconnected"))
      }
      this.pending.clear()
      if (reconnectImmediately) {
        this.connect()
        return
      }
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5_000)
    }, this.reconnectDelayMs)
  }

  private getStatus(): SocketStatus {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return "connected"
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return "connecting"
    }
    return "disconnected"
  }

  private emitStatus(status: SocketStatus) {
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }

  private isConnectionStale() {
    const baseline = Math.max(this.lastMessageAt, this.lastOpenAt)
    return baseline > 0 && Date.now() - baseline >= STALE_CONNECTION_MS
  }

  private sendPing() {
    if (this.pingPromise) {
      return this.pingPromise
    }

    const pingPromise = this.command({ type: "system.ping" })
      .then(() => {
        this.clearPingState()
      })
      .catch((error) => {
        this.clearPingState()
        this.reconnectNow()
        throw error
      })

    this.pingTimeoutTimer = window.setTimeout(() => {
      this.clearPingState()
      this.reconnectNow()
    }, PING_TIMEOUT_MS)

    this.pingPromise = pingPromise
    return pingPromise
  }

  private reconnectNow() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect()
      return
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return
    }

    this.reconnectImmediatelyOnClose = true
    this.ws.close()
  }

  private startHeartbeat() {
    if (document.visibilityState !== "visible") {
      return
    }

    if (this.heartbeatTimer !== null) {
      return
    }

    this.heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        this.stopHeartbeat()
        return
      }
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return
      }
      void this.ensureHealthyConnection()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPingState() {
    if (this.pingTimeoutTimer !== null) {
      window.clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
    this.pingPromise = null
  }

  private enqueue(envelope: ClientEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(envelope)
      return
    }
    if (envelope.type === "command" && envelope.command.type === "chat.answerAsyncQuestion") {
      traceAsyncAnswer("queued_locally", { commandId: envelope.id, submissionId: envelope.command.submissionId })
    }
    this.outboundQueue.push(envelope)
  }

  private sendNow(envelope: ClientEnvelope) {
    if (envelope.type === "command" && envelope.command.type === "chat.answerAsyncQuestion") {
      traceAsyncAnswer("command_sent", { commandId: envelope.id, submissionId: envelope.command.submissionId })
    }
    this.transport?.send(JSON.stringify(envelope))
  }
}
