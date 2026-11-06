import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChatInputDock } from "../../../src/client/app/ChatPage/ChatInputDock"
import type { ChatInputHandle } from "../../../src/client/components/chat-ui/ChatInput"
import { useAppSettingsStore } from "../../../src/client/stores/appSettingsStore"
import { updateSessionStatistics, type StatisticsRecord } from "../../../src/shared/session-statistics"
import { PROVIDERS, type AppSettingsSnapshot } from "../../../src/shared/types"
import "../../../src/index.css"

// Exercise the real sibling reconciliation, composer and popovers. No provider
// traffic or user data is involved; settlements use the production DSH folds.
useAppSettingsStore.setState({ settings: { showSessionStatistics: true } as AppSettingsSnapshot })
const errors: string[] = []
window.addEventListener("error", event => errors.push(event.message))
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)))
const originalError = console.error
console.error = (...args) => { errors.push(args.map(String).join(" ")); originalError(...args) }

function settle(previous: StatisticsRecord | undefined, step: number, outputTokens: number) {
  const time = step * 3000
  return updateSessionStatistics(previous, { runId: "fixture-run", events: [
    { type: "step/start", time, data: { step } },
    { type: "assistant/message", time: time + 1200, data: { step,
      usage: { inputTokens: 100, outputTokens },
      stream: [{ type: "chunk", time: time + 200, chunk: { type: "text-delta", text: "Synthetic response" } }],
    } },
    { type: "step/end", time: time + 1200, data: { step } },
  ] })
}
const records: Record<string, StatisticsRecord | undefined> = {
  a: settle(undefined, 1, 27), b: settle(undefined, 1, 200),
  exec: updateSessionStatistics(undefined, { runId: "exec", usageOnly: true, events: [
    { type: "assistant/message", time: 1, data: { usage: { inputTokens: 50, outputTokens: 10 } } },
  ] }),
  pending: updateSessionStatistics(undefined, { runId: "pending", events: [
    { type: "step/start", time: 1, data: { step: 1 } },
    { type: "step/end", time: 2, data: { step: 1 } },
  ] }),
}
let select: (chat: string) => void
let rerender: () => void
let active = "a"
const onLayoutChange = () => {}
function App() {
  const [chat, setChat] = useState("a")
  const [, setRevision] = useState(0)
  const inputRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const inputElementRef = useRef<HTMLTextAreaElement>(null)
  active = chat; select = setChat; rerender = () => setRevision(value => value + 1)
  return <main data-fixture-chat={chat} className="relative h-dvh bg-background text-foreground">
    <ChatInputDock statistics={records[chat]?.snapshot ?? null}
      inputRef={inputRef} onLayoutChange={onLayoutChange} chatInputRef={chatInputRef} chatInputElementRef={inputElementRef}
      activeChatId={chat} previousPrompt={null} hasSelectedProject runtimeStatus={null} canCancel={false}
      projectId="fixture-project" activeProvider="codex" codexTransport={chat === "exec" ? "exec" : "app-server"}
      preferencesReady availableProviders={PROVIDERS.filter(provider => provider.id === "codex")} onSubmit={async () => {}} onCancel={() => {}} />
  </main>
}
createRoot(document.getElementById("root")!).render(<App />)
Object.assign(window, { fixture: {
  errors,
  select: (chat: string) => select(chat),
  advance: () => { records[active] = settle(records[active], 2, 200); rerender() },
  visible: (value: boolean) => useAppSettingsStore.setState({ settings: { showSessionStatistics: value } as AppSettingsSnapshot }),
} })
