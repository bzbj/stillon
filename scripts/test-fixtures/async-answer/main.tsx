import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AsyncQuestionMessage } from "../../../src/client/components/messages/AsyncQuestionMessage"
import { AsyncQuestionDelivery } from "../../../src/client/app/asyncQuestionDelivery"
import { AsyncQuestionDeliveryContext } from "../../../src/client/app/asyncQuestionDeliveryContext"
import { StillOnSocket } from "../../../src/client/app/socket"
import { asyncQuestionKey } from "../../../src/shared/types"
import type { AsyncQuestionResponse, HydratedTranscriptMessage } from "../../../src/shared/types"
import "../../../src/index.css"

// Fake transport controls timing; the actual socket and React component run unchanged.
class ControlledSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  static instances: ControlledSocket[] = []
  readyState = 0
  handlers = new Map<string, Array<(event: any) => void>>()
  constructor(_url: string) { ControlledSocket.instances.push(this) }
  addEventListener(type: string, callback: (event: any) => void) {
    this.handlers.set(type, [...this.handlers.get(type) ?? [], callback])
  }
  emit(type: string, event?: any) { this.handlers.get(type)?.forEach((callback) => callback(event)) }
  open() { this.readyState = 1; this.emit("open") }
  close() { this.readyState = 3; this.emit("close") }
  send(raw: string) {
    const message = JSON.parse(raw)
    if (message.type !== "command") return
    commands.push(message)
    if (message.command.type === "chat.getAsyncQuestionResponse" && queryMode !== "drop") {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(queryMode === "error"
        ? { v: 1, type: "error", id: message.id, message: "fixture-only error" }
        : { v: 1, type: "ack", id: message.id, result: record }) }))
    }
  }
}
Object.defineProperty(window, "WebSocket", { value: ControlledSocket })
const commands: any[] = []
let record: AsyncQuestionResponse | null = null
let queryMode = "record"
const socket = new StillOnSocket("ws://fixture/ws")
socket.start()
ControlledSocket.instances.at(-1)!.open()
const delivery = new AsyncQuestionDelivery(socket)
const message: Extract<HydratedTranscriptMessage, { kind: "assistant_text" }> = {
  id: "question", timestamp: new Date(0).toISOString(), kind: "assistant_text", text: "Synthetic question",
  asyncQuestion: { threadId: "thread-fixture", originTurnId: "turn-fixture", providerItemId: "item-fixture", questions: [
    { index: 0, title: "Choose a format", options: ["HTML", "Markdown"] },
    { index: 1, title: "Any constraints?", options: null },
  ] },
}
let setResponse: (value: AsyncQuestionResponse | undefined) => void
let setMounted: (value: boolean) => void
let setChat: (value: string) => void
let setReadOnly: (value: boolean) => void
function App() {
  const [response, changeResponse] = useState<AsyncQuestionResponse>()
  const [mounted, changeMounted] = useState(true)
  const [chatId, changeChat] = useState("chat-fixture")
  const [readOnly, changeReadOnly] = useState(false)
  setResponse = changeResponse; setMounted = changeMounted; setChat = changeChat; setReadOnly = changeReadOnly
  return <main className="p-3 max-w-2xl mx-auto"><AsyncQuestionDeliveryContext.Provider value={{ chatId, delivery }}>
    {mounted ? <AsyncQuestionMessage key={chatId} message={message} response={response} readOnly={readOnly} onSubmit={() => Promise.reject(new Error("context must submit"))} /> : null}
  </AsyncQuestionDeliveryContext.Provider></main>
}
createRoot(document.getElementById("root")!).render(<App />)
Object.assign(window, { fixture: {
  commands,
  disconnect: () => ControlledSocket.instances.at(-1)!.close(),
  reconnect: async () => { await socket.ensureHealthyConnection(); ControlledSocket.instances.at(-1)!.open() },
  record: (status: AsyncQuestionResponse["status"], overrides = {}) => {
    const command = commands.findLast((entry) => entry.command.type === "chat.answerAsyncQuestion")!.command
    record = { ...command, schemaVersion: 1, status, error: null, localMessageId: null, providerTurnId: null, createdAt: 1, updatedAt: Date.now(), ...overrides }
  },
  queryMode: (mode: string) => { queryMode = mode },
  queryReply: (error = false) => {
    const query = commands.findLast((entry) => entry.command.type === "chat.getAsyncQuestionResponse")!
    ControlledSocket.instances.at(-1)!.emit("message", { data: JSON.stringify(error
      ? { v: 1, type: "error", id: query.id, message: "fixture-only error" }
      : { v: 1, type: "ack", id: query.id, result: record }) })
  },
  ack: (status: string) => {
    const command = commands.findLast((entry) => entry.command.type === "chat.answerAsyncQuestion")!
    ControlledSocket.instances.at(-1)!.emit("message", { data: JSON.stringify({ v: 1, type: "ack", id: command.id, result: { ...command.command, status } }) })
  },
  snapshot: () => setResponse(record ?? undefined),
  mount: (value: boolean) => setMounted(value),
  chat: (value: string) => { setResponse(undefined); setChat(value) },
  readOnly: (value: boolean) => setReadOnly(value),
  longQuestions: () => {
    message.asyncQuestion!.questions[0]!.title = "SyntheticLongQuestion".repeat(50)
    const response = delivery.get("chat-fixture", asyncQuestionKey(message.asyncQuestion!))!
    setResponse({ ...response, schemaVersion: 1, createdAt: 1, updatedAt: Date.now(), error: null, localMessageId: null, providerTurnId: null })
  },
} })
