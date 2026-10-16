import type { ReactNode } from "react"
import { Archive, Copy, EyeOff, FolderOpen, Palette, Pencil, Split, Trash2, UserRoundPlus } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"

export function ProjectSectionMenu({
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onHide,
  onCustomizeAvatar,
  children,
}: {
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onOpenInFinder: () => void
  onHide: () => void
  onCustomizeAvatar?: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onCustomizeAvatar ? <ContextMenuItem onSelect={event => { event.preventDefault(); onCustomizeAvatar() }}><Palette className="h-3.5 w-3.5" /><span className="text-xs font-medium">Change avatar</span></ContextMenuItem> : null}
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
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Copy Path</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onShowArchived()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show Archived</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Show in Finder</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onHide()
          }}
        >
          <EyeOff className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Hide</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatRowMenu({
  canFork,
  onRename,
  onShare,
  onOpenInFinder,
  onFork,
  onArchive,
  onDelete,
  children,
}: {
  canFork?: boolean
  onRename: () => void
  onShare: () => void
  onOpenInFinder: () => void
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
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">Open in Finder</span>
        </ContextMenuItem>
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
