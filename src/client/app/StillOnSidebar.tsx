import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { X, Menu, Search, PanelLeftClose, PanelLeftOpen, MessageCirclePlus, Settings } from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { Button } from "../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog"
import { formatSidebarAgeLabel } from "../lib/formatters"
import { getSidebarChatTimestamp } from "../lib/sidebarChats"
import { cn } from "../lib/utils"
import { ChatRow } from "../components/chat-ui/sidebar/ChatRow"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { getResolvedKeybindings } from "../lib/keybindings"
import type { KeybindingsSnapshot, SidebarData, SidebarChatRow } from "../../shared/types"
import type { SocketStatus } from "./socket"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"

const SIDEBAR_WIDTH_STORAGE_KEY = "kanna:sidebar-width"
export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 520
export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

function readStoredSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  return stored ? clampSidebarWidth(Number(stored)) : DEFAULT_SIDEBAR_WIDTH
}

function persistSidebarWidth(width: number) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
}

function BrandMark({ className }: { className?: string }) {
  return <img src="/stillon-mark.svg" alt="" aria-hidden="true" draggable={false} className={className} />
}

function SidebarIdentity({ machineName }: { machineName: string | null }) {
  if (!machineName) {
    return (
      <>
        <span aria-hidden="true" className="h-5 w-28 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
        <span className="sr-only" role="status">Loading machine name…</span>
      </>
    )
  }

  return (
    <span className="font-machine-identity block min-w-0 max-w-[230px] shrink truncate text-[23px] leading-7 text-foreground" title={machineName}>
      {machineName}
    </span>
  )
}

export function getConnectionStatusPresentation(
  connectionStatus: SocketStatus,
  ready: boolean,
  snapshotStatus: "empty" | "cached" | "authoritative" = ready ? "authoritative" : "empty"
) {
  if (!ready && snapshotStatus === "cached") {
    return {
      label: "Last known",
      description: "Showing a saved sidebar while this machine reconnects",
      dotClassName: "bg-amber-400 animate-pulse",
    }
  }

  if (connectionStatus === "connected" && ready) {
    return {
      label: "Still On",
      description: "Connected to this machine",
      dotClassName: "bg-emerald-400 shadow-[0_0_0_3px] shadow-emerald-500/15",
    }
  }

  if (connectionStatus === "connecting" || !ready) {
    return {
      label: "Reconnecting…",
      description: "Reconnecting to this machine",
      dotClassName: "bg-amber-400 animate-pulse",
    }
  }

  return {
    label: "Out of Reach",
    description: "This machine is currently unreachable",
    dotClassName: "bg-rose-400",
  }
}

interface StillOnSidebarProps {
  data: SidebarData
  activeChatId: string | null
  machineName: string | null
  connectionStatus: SocketStatus
  ready: boolean
  snapshotStatus: "empty" | "cached" | "authoritative"
  open: boolean
  collapsed: boolean
  showMobileOpenButton: boolean
  onOpen: () => void
  onClose: () => void
  onCollapse: () => void
  onExpand: () => void
  onCreateChat: (projectId: string) => void
  onForkChat: (chat: SidebarChatRow) => void
  currentProjectId: string | null
  keybindings: KeybindingsSnapshot | null
  onRenameChat: (chat: SidebarChatRow) => void
  onShareChat: (chatId: string) => void
  onArchiveChat: (chat: SidebarChatRow) => void
  onOpenArchivedChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarChatRow) => void
  onOpenAddProjectModal: () => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject: (projectId: string) => void
  onReorderProjectGroups: (projectIds: string[]) => void
  editorLabel: string
}

function StillOnSidebarImpl({
  data,
  activeChatId,
  machineName,
  connectionStatus,
  ready,
  snapshotStatus,
  open,
  collapsed,
  showMobileOpenButton,
  onOpen,
  onClose,
  onCollapse,
  onExpand,
  onCreateChat,
  onForkChat,
  currentProjectId,
  keybindings,
  onRenameChat,
  onShareChat,
  onArchiveChat,
  onOpenArchivedChat,
  onDeleteChat,
  onOpenAddProjectModal,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  onReorderProjectGroups,
  editorLabel,
}: StillOnSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const actionsEnabled = connectionStatus === "connected" && ready
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return []
    return data.projectGroups.flatMap((group) => group.chats
      .filter((chat) => `${chat.title} ${group.sidebarTitle ?? group.title}`.toLocaleLowerCase().includes(query))
      .map((chat) => ({ chat, projectTitle: group.sidebarTitle ?? group.title })))
      .sort((a, b) => (b.chat.lastMessageAt ?? b.chat._creationTime) - (a.chat.lastMessageAt ?? a.chat._creationTime))
  }, [data.projectGroups, searchQuery])
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const visibleChats = useMemo(
    () => getVisibleSidebarChats(data.projectGroups, collapsedSections, expandedGroups),
    [collapsedSections, data.projectGroups, expandedGroups]
  )
  const visibleChatsRef = useRef(visibleChats)
  const visibleIndexByChatId = useMemo(
    () => new Map(visibleChats.map((entry) => [entry.chat.chatId, entry.visibleIndex])),
    [visibleChats]
  )

  const projectIdByPath = useMemo(
    () => new Map(data.projectGroups.map((group) => [group.localPath, group.groupKey])),
    [data.projectGroups]
  )

  const activeVisibleCount = visibleChats.length
  const archivedProject = useMemo(
    () => data.projectGroups.find((group) => group.groupKey === archivedProjectId) ?? null,
    [archivedProjectId, data.projectGroups]
  )

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const projectKeys = new Set(data.projectGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of data.projectGroups) {
        if (initializedCollapsedGroupKeysRef.current.has(group.groupKey)) continue
        initializedCollapsedGroupKeysRef.current.add(group.groupKey)
        if (group.defaultCollapsed) {
          next.add(group.groupKey)
        }
      }

      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }

      return next
    })
  }, [data.projectGroups])

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const toggleExpandedGroup = useCallback((key: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const renderChatRow = useCallback((chat: SidebarChatRow) => {
    const visibleIndex = visibleIndexByChatId.get(chat.chatId)

    return (
      <ChatRow
        key={chat._id}
        chat={chat}
        activeChatId={activeChatId}
        nowMs={nowMs}
        shortcutHint={visibleIndex ? getSidebarNumberJumpHint(resolvedKeybindings, visibleIndex) : null}
        showShortcutHint={showNumberJumpHints}
        actionsEnabled={actionsEnabled}
        onSelectChat={(chatId) => {
          navigate(`/chat/${chatId}`)
          onClose()
        }}
        onRenameChat={() => onRenameChat(chat)}
        onShareChat={() => onShareChat(chat.chatId)}
        onOpenInFinder={() => onOpenExternalPath("open_finder", chat.localPath)}
        onForkChat={() => onForkChat(chat)}
        onArchiveChat={() => onArchiveChat(chat)}
        onDeleteChat={() => onDeleteChat(chat)}
      />
    )
  }, [actionsEnabled, activeChatId, navigate, nowMs, onArchiveChat, onClose, onDeleteChat, onForkChat, onOpenExternalPath, onRenameChat, onShareChat, resolvedKeybindings, showNumberJumpHints, visibleIndexByChatId])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 30_000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))

      if (isSidebarModifierShortcut(resolvedKeybindings, "createChatInCurrentProject", event)) {
        if (!actionsEnabled || !currentProjectId) {
          return
        }

        event.preventDefault()
        onCreateChat(currentProjectId)
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "openAddProject", event)) {
        event.preventDefault()
        navigate("/")
        onClose()
        onOpenAddProjectModal()
        return
      }

      const targetIndex = getSidebarJumpTargetIndex(resolvedKeybindings, event)
      if (targetIndex === null) {
        return
      }

      const targetChat = visibleChatsRef.current[targetIndex - 1]?.chat
      if (!targetChat) {
        return
      }

      event.preventDefault()
      navigate(`/chat/${targetChat.chatId}`)
      onClose()
    }

    function handleKeyUp(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))
    }

    function clearHints() {
      setShowNumberJumpHints(false)
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", clearHints)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", clearHints)
    }
  }, [actionsEnabled, currentProjectId, navigate, onClose, onCreateChat, onOpenAddProjectModal, resolvedKeybindings])

  useEffect(() => {
    if (!activeChatId || !scrollContainerRef.current) return

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      const activeElement = container?.querySelector(`[data-chat-id="${activeChatId}"]`) as HTMLElement | null
      if (!activeElement || !container) return

      const elementRect = activeElement.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()

      if (elementRect.top < containerRect.top + 38) {
        const relativeTop = elementRect.top - containerRect.top + container.scrollTop
        container.scrollTo({ top: relativeTop - 38, behavior: "smooth" })
      } else if (elementRect.bottom > containerRect.bottom) {
        const elementCenter = elementRect.top + elementRect.height / 2 - containerRect.top + container.scrollTop
        const containerCenter = container.clientHeight / 2
        container.scrollTo({ top: elementCenter - containerCenter, behavior: "smooth" })
      }
    })
  }, [activeChatId])

  useEffect(() => {
    if (!isResizingSidebar) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    function handlePointerMove(event: PointerEvent) {
      const resizeStart = resizeStartRef.current
      if (!resizeStart) return
      setSidebarWidth(clampSidebarWidth(resizeStart.width + event.clientX - resizeStart.pointerX))
    }

    function handlePointerUp() {
      setIsResizingSidebar(false)
      resizeStartRef.current = null
      setSidebarWidth((current) => {
        const next = clampSidebarWidth(current)
        persistSidebarWidth(next)
        return next
      })
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp, { once: true })

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isResizingSidebar])

  const hasVisibleChats = activeVisibleCount > 0
  const isSettingsActive = location.pathname.startsWith("/settings")
  const isConnecting = connectionStatus === "connecting" || !ready
  const connectionPresentation = getConnectionStatusPresentation(connectionStatus, ready, snapshotStatus)

  return (
    <>
      {!open && showMobileOpenButton && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-3 left-3 z-50 md:hidden"
          onClick={onOpen}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {collapsed && (
        <div className="fixed left-5 top-5 z-40 hidden items-center gap-4 md:flex">
          <button
            type="button"
            onClick={() => navigate("/")}
            aria-label="Go to home"
            title="Go to home"
            className="flex size-9 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BrandMark className="size-8 rounded-md object-contain" />
          </button>
          <div className="flex items-center rounded-full border border-border bg-background p-1 shadow-sm">
            <Button variant="ghost" size="icon" onClick={onExpand} title="Open sidebar" aria-label="Open sidebar" className="size-9 rounded-full">
              <PanelLeftOpen className="size-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => navigate("/")} title="New chat" aria-label="New chat" className="size-9 rounded-full">
              <MessageCirclePlus className="size-5" />
            </Button>
          </div>
        </div>
      )}

      <div
        data-sidebar="open"
        className={cn(
          "fixed inset-0 z-50 bg-background dark:bg-card flex flex-col h-[100dvh] select-none",
          "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:mr-0 md:h-[calc(100dvh-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
          open ? "flex" : "hidden md:flex",
          collapsed && "md:hidden",
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="px-[5px] h-[47px] md:h-auto md:min-h-[64px] md:py-2 border-b grid grid-cols-[40px_minmax(0,1fr)_80px] items-center md:pl-3 md:pr-2 md:flex md:justify-between">
          <div className="md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 rounded-lg hover:!border-border/0"
              onClick={onClose}
              title="Close sidebar"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <button
            type="button"
            onClick={() => {
              navigate("/")
              onClose()
            }}
            aria-label="Go to home"
            title="Go to home"
            className="flex min-w-0 items-center justify-self-center gap-2 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:justify-self-auto"
          >
            <BrandMark className="h-7 w-7 shrink-0 rounded-md object-contain sm:h-8 sm:w-8" />
            <SidebarIdentity machineName={machineName} />
          </button>
          <div className="flex items-center justify-self-end md:justify-self-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSearchOpen((current) => !current)
                setSearchQuery("")
              }}
              className="size-10 rounded-full"
              title="Search conversations"
              aria-label="Search conversations"
            >
              <Search className="size-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onCollapse}
              className="hidden size-10 rounded-full md:inline-flex"
              title="Close sidebar"
              aria-label="Close sidebar"
            >
              <PanelLeftClose className="size-5" />
            </Button>
          </div>
        </div>

        <div className="px-3 pb-3 pt-2">
          <button
            type="button"
            onClick={() => {
              navigate("/")
              onClose()
            }}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full border border-border bg-background text-base font-medium shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MessageCirclePlus className="size-5" />
            New chat
          </button>
        </div>

        {searchOpen && (
          <div className="border-b border-border px-3 pb-3">
            <input
              autoFocus
              type="search"
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false)
                  setSearchQuery("")
                }
              }}
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>
        )}

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
          }}
        >
          <div className="p-[7px]">
            {!ready && snapshotStatus === "cached" ? (
              <div
                role="status"
                className="mx-1 mb-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
              >
                Last-known conversations · {connectionStatus === "disconnected" ? "offline" : "updating…"}
              </div>
            ) : null}

            {!hasVisibleChats && isConnecting ? (
              <div className="space-y-5 px-1 pt-3">
                {[0, 1, 2].map((section) => (
                  <div key={section} className="space-y-2 animate-pulse">
                    <div className="h-4 w-28 rounded bg-muted" />
                    <div className="space-y-1">
                      {[0, 1, 2].map((row) => (
                        <div key={row} className="flex items-center gap-2 rounded-md px-3 py-2">
                          <div className="h-3.5 w-3.5 rounded-full bg-muted" />
                          <div
                            className={cn(
                              "h-3.5 rounded bg-muted",
                              row === 0 ? "w-32" : row === 1 ? "w-40" : "w-28"
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {!hasVisibleChats && !isConnecting && data.projectGroups.length === 0 ? (
              <p className="text-sm text-slate-400 p-2 mt-6 text-center">No conversations yet</p>
            ) : null}

            {searchOpen && searchQuery.trim() ? (
              <div className="space-y-1 px-1 pt-2">
                {searchResults.length === 0 ? (
                  <p className="px-3 py-5 text-center text-sm text-muted-foreground">No matching conversations</p>
                ) : searchResults.map(({ chat, projectTitle }) => (
                  <button
                    key={chat.chatId}
                    type="button"
                    onClick={() => {
                      navigate(`/chat/${chat.chatId}`)
                      setSearchOpen(false)
                      setSearchQuery("")
                      onClose()
                    }}
                    className="w-full rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-sm text-foreground">{chat.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{projectTitle}</span>
                  </button>
                ))}
              </div>
            ) : <LocalProjectsSection
              projectGroups={data.projectGroups}
              editorLabel={editorLabel}
              onReorderGroups={onReorderProjectGroups}
              collapsedSections={collapsedSections}
              expandedGroups={expandedGroups}
              onToggleSection={toggleSection}
              onToggleExpandedGroup={toggleExpandedGroup}
              renderChatRow={renderChatRow}
              onShowArchivedProject={setArchivedProjectId}
              onNewLocalChat={(localPath) => {
                const projectId = projectIdByPath.get(localPath)
                if (projectId) {
                  onCreateChat(projectId)
                }
              }}
              onCopyPath={onCopyPath}
              onOpenExternalPath={onOpenExternalPath}
              onRenameProject={onRenameProject}
              onHideProject={onHideProject}
              isConnected={actionsEnabled}
              actionsEnabled={actionsEnabled}
            />}
          </div>
        </div>

        <div className="border-t border-border p-2">
            <button
            type="button"
            onClick={() => {
              navigate("/settings/welcome")
              onClose()
            }}
            className={cn(
              "w-full rounded-xl rounded-t-md border px-3 py-2 text-left transition-colors",
              isSettingsActive
                ? "bg-muted border-border"
                : "border-border/0 hover:bg-muted hover:border-border active:bg-muted/80"
            )}
          >
            <div className="flex items- justify-between gap-2">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Settings</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground" title={connectionPresentation.description}>
                <span className="font-logo font-semibold tracking-[0.01em]">{connectionPresentation.label}</span>
                <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", connectionPresentation.dotClassName)} />
              </div>
            </div>
          </button>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          title="Resize sidebar"
          className={cn(
            "hidden md:block absolute -right-1 top-3 bottom-3 z-20 w-2 cursor-col-resize rounded-full",
            "focus-visible:outline-none"
          )}
          onPointerDown={(event) => {
            event.preventDefault()
            resizeStartRef.current = {
              pointerX: event.clientX,
              width: sidebarWidth,
            }
            setIsResizingSidebar(true)
          }}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
            persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
          }}
          onKeyDown={(event) => {
            let nextWidth: number | null = null
            if (event.key === "ArrowLeft") nextWidth = sidebarWidth - 16
            else if (event.key === "ArrowRight") nextWidth = sidebarWidth + 16
            else if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH
            else if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH
            else if (event.key === "Enter") nextWidth = DEFAULT_SIDEBAR_WIDTH
            if (nextWidth === null) return
            event.preventDefault()
            const clampedWidth = clampSidebarWidth(nextWidth)
            setSidebarWidth(clampedWidth)
            persistSidebarWidth(clampedWidth)
          }}
        />
      </div>

      <Dialog
        open={Boolean(archivedProject)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setArchivedProjectId(null)
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Archived Chats</DialogTitle>
            <DialogDescription>
              {archivedProject?.localPath ?? ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1">
            {archivedProject?.archivedChats?.length ? (
              archivedProject.archivedChats.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/0 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted"
                  onClick={() => {
                    if (!actionsEnabled) return
                    onOpenArchivedChat(chat.chatId)
                    setArchivedProjectId(null)
                    onClose()
                  }}
                  disabled={!actionsEnabled}
                >
                  <span className="min-w-0 truncate text-sm">{chat.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSidebarAgeLabel(getSidebarChatTimestamp(chat), nowMs)}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-1 py-3 text-sm text-muted-foreground">No archived chats</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {open ? <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} /> : null}
    </>
  )
}

export const StillOnSidebar = memo(StillOnSidebarImpl)
