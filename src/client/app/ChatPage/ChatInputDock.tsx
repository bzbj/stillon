import { memo, type RefObject } from "react"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { StillOnState } from "../useStillOnState"
import type { CodexTransport } from "../../../shared/types"

interface ChatInputDockProps {
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
  activeProvider: "claude" | "codex" | null
  codexTransport: CodexTransport | null
  preferencesReady: boolean
  availableProviders: StillOnState["availableProviders"]
  contextWindowSnapshot: ContextWindowSnapshot | null
  onSubmit: StillOnState["handleSend"]
  onCancel: () => void
}

export const ChatInputDock = memo(function ChatInputDock({
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
  contextWindowSnapshot,
  onSubmit,
  onCancel,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={inputRef}>
        {activeProvider === "codex" && codexTransport ? (
          <p className="px-4 pb-1 text-right text-xs text-muted-foreground">
            Codex · {codexTransport === "exec" ? "Exec" : "App Server"}
          </p>
        ) : null}
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          onLayoutChange={onLayoutChange}
          key={activeChatId ?? "new-chat"}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={!hasSelectedProject || !preferencesReady}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          preferencesReady={preferencesReady}
          availableProviders={availableProviders}
          contextWindowSnapshot={contextWindowSnapshot}
          previousPrompt={previousPrompt}
        />
      </div>
    </div>
  )
})
