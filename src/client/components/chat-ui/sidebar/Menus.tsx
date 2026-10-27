import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { Archive, ChevronLeft, ChevronRight, Copy, EyeOff, FolderOpen, Palette, Pencil, Pin, PinOff, Settings2, Sparkles, Split, Trash2, UserRoundPlus } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "../../ui/context-menu"

import { normalizeQuickCommands, type QuickCommand } from "../../../../shared/quick-commands"
import { useAppSettingsStore } from "../../../stores/appSettingsStore"

const narrowMenuQuery = "(max-width: 767px)"
function subscribeToNarrowMenu(listener: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia(narrowMenuQuery)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}
function isNarrowMenu() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.(narrowMenuQuery).matches)
}

export function ProjectSectionMenu({
  workspaceId, onRunQuickCommand, onManageCommands, onRename, onCopyPath,
  onShowArchived, onHide, onCustomizeAvatar, onShareWorkspace, canManageWorkspace = true, children,
}: {
  workspaceId?: string
  onRunQuickCommand?: (command: QuickCommand) => void
  onManageCommands?: () => void
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onHide: () => void
  onShareWorkspace?: () => void
  canManageWorkspace?: boolean
  onCustomizeAvatar?: () => void
  children: ReactNode
}) {
  const stored = useAppSettingsStore(store => store.settings?.quickCommands)
  const commands = useMemo(() => normalizeQuickCommands(stored), [stored])
  const local = workspaceId ? commands.workspaces[workspaceId] ?? [] : []
  const narrow = useSyncExternalStore(subscribeToNarrowMenu, isNarrowMenu, () => false)
  const [showCommands, setShowCommands] = useState(false)
  const quickItems = <>
    {commands.global.map(command => <ContextMenuItem key={`global:${command.id}`} disabled={!onRunQuickCommand} title={command.description || command.name} onSelect={() => onRunQuickCommand?.({ ...command })}><span className="max-w-72 truncate">{command.name}</span></ContextMenuItem>)}
    {commands.global.length && local.length ? <ContextMenuSeparator className="mx-2 bg-border/50" /> : null}
    {local.map(command => <ContextMenuItem key={`workspace:${command.id}`} disabled={!onRunQuickCommand} title={command.description || command.name} onSelect={() => onRunQuickCommand?.({ ...command })}><span className="max-w-72 truncate">{command.name}</span></ContextMenuItem>)}
    {commands.global.length || local.length ? <ContextMenuSeparator className="mx-2 bg-border/50" /> : null}
    <ContextMenuItem onSelect={event => { event.preventDefault(); onManageCommands?.() }}><Settings2 className="size-3.5" />Manage Workspace Prompts…</ContextMenuItem>
  </>

  return <ContextMenu onOpenChange={open => { if (!open) setShowCommands(false) }}>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent aria-label={narrow && showCommands ? "Preset Prompts" : undefined} className="max-h-[var(--radix-context-menu-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto">
      {narrow && showCommands ? <>
        <ContextMenuItem closeOnSelect={false} onSelect={event => { event.preventDefault(); setShowCommands(false) }}><ChevronLeft className="size-3.5" />Back</ContextMenuItem>
        <ContextMenuSeparator className="mx-2 bg-border/50" />
        {quickItems}
      </> : <>
        {onManageCommands ? narrow ? (
          <ContextMenuItem closeOnSelect={false} onSelect={event => { event.preventDefault(); setShowCommands(true) }}><Sparkles className="size-3.5" />Preset Prompts<ChevronRight className="ml-auto size-3.5" /></ContextMenuItem>
        ) : (
          <ContextMenuSub>
            <ContextMenuSubTrigger><Sparkles className="size-3.5" />Preset Prompts<ChevronRight className="ml-auto size-3.5" /></ContextMenuSubTrigger>
            <ContextMenuSubContent>{quickItems}</ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        {onShareWorkspace ? <ContextMenuItem onSelect={event => { event.preventDefault(); onShareWorkspace() }}><UserRoundPlus className="size-3.5" />Share</ContextMenuItem> : null}
        {canManageWorkspace ? <ContextMenuItem onSelect={event => { event.preventDefault(); onRename() }}><Pencil className="size-3.5" />Rename</ContextMenuItem> : null}
        {canManageWorkspace && onCustomizeAvatar ? <ContextMenuItem onSelect={event => { event.preventDefault(); onCustomizeAvatar() }}><Palette className="size-3.5" />Change avatar</ContextMenuItem> : null}
        <ContextMenuItem onSelect={onCopyPath}><Copy className="size-3.5" />Copy Path</ContextMenuItem>
        <ContextMenuItem onSelect={onShowArchived}><Archive className="size-3.5" />Show Archived</ContextMenuItem>
        {canManageWorkspace ? <ContextMenuItem onSelect={onHide}><EyeOff className="size-3.5" />Hide</ContextMenuItem> : null}
      </>}
    </ContextMenuContent>
  </ContextMenu>
}

export function ChatRowMenu({
  pinned,
  onPin,
  canFork,
  onRename,
  onShare,
  onOpenInFinder,
  onFork,
  onArchive,
  onDelete,
  children,
}: {
  pinned?: boolean
  onPin?: () => void
  canFork?: boolean
  onRename: () => void
  onShare: () => void
  onOpenInFinder?: () => void
  onFork: () => void
  onArchive: () => void
  onDelete: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onPin ? <ContextMenuItem onSelect={onPin}>
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          {pinned ? "Unpin chat" : "Pin chat"}
        </ContextMenuItem> : null}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Rename</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onShare()
          }}
        >
          <UserRoundPlus className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Share</span>
        </ContextMenuItem>
        {onOpenInFinder && <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in Finder</span>
        </ContextMenuItem>}
        <ContextMenuItem
          disabled={!canFork}
          onSelect={(event) => {
            event.preventDefault()
            if (!canFork) return
            onFork()
          }}
        >
          <Split className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Fork</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onArchive()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Archive</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onDelete()
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Delete</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
