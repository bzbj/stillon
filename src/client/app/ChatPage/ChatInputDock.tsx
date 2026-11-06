import { SessionStatistics } from "../../components/chat-ui/SessionStatistics"
import { memo, type RefObject } from "react"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import type { StillOnState } from "../useStillOnState"
import type { CodexTransport } from "../../../shared/types"

interface ChatInputDockProps {
  statistics?: import("../../../shared/session-statistics").SessionStatistics | null
  inputRef: RefObject<HTMLDivElement | null>
  onLayoutChange: () => void
  chatInputRef: RefObject<ChatInputHandle | null>
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>
  activeChatId: string | null
  previousPrompt: string | null
  hasSelectedProject: boolean
  runtimeStatus: string | null
  canCancel: boolean
  projectId: string | null
  activeProvider: "claude" | "codex" | "deepseek" | null
  codexTransport: CodexTransport | null
  preferencesReady: boolean
  availableProviders: StillOnState["availableProviders"]
  onSubmit: StillOnState["handleSend"]
  onCancel: () => void
}

export const ChatInputDock = memo(function ChatInputDock({
  statistics,
  inputRef,
  onLayoutChange,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  previousPrompt,
  hasSelectedProject,
  runtimeStatus,
  canCancel,
  projectId,
  activeProvider,
  codexTransport,
  preferencesReady,
  availableProviders,
  onSubmit,
  onCancel,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={inputRef}>
        <SessionStatistics
          key={`statistics:${activeChatId ?? "new-chat"}`}
          statistics={statistics ?? null}
          timingUnavailable={activeProvider === "codex" && codexTransport === "exec"}
          onLayoutChange={onLayoutChange}
        />
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          onLayoutChange={onLayoutChange}
          key={`input:${activeChatId ?? "new-chat"}`}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={!hasSelectedProject || !preferencesReady}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          codexTransport={codexTransport}
          preferencesReady={preferencesReady}
          availableProviders={availableProviders}
          previousPrompt={previousPrompt}
        />
      </div>
    </div>
  )
})
