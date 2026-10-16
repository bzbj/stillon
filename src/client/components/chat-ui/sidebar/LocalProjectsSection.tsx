import { memo, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { WorkspaceAvatar } from "../../WorkspaceAvatar"
import { WorkspaceAvatarPicker } from "../../WorkspaceAvatarPicker"
import { useWorkspaceAvatarsStore } from "../../../stores/workspaceAvatarsStore"
import { ChevronRight, GripVertical, Loader2, MessageCirclePlus, MoreHorizontal } from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "../../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { APP_NAME } from "../../../../shared/branding"
import { getPathBasename } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { ProjectSectionMenu } from "./Menus"

interface Props {
  projectGroups: SidebarProjectGroup[]
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  onReorderGroups?: (newOrder: string[]) => void
  isConnected?: boolean
  actionsEnabled?: boolean
  startingLocalPath?: string | null
}

interface SortableProjectGroupProps {
  group: SidebarProjectGroup
  isReorderEnabled: boolean
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  isConnected?: boolean
  actionsEnabled: boolean
  startingLocalPath?: string | null
}

const DRAG_REORDER_TRIGGER_OFFSET_PX = 20
const SIDEBAR_REORDER_MEDIA_QUERY = "(min-width: 768px)"

function subscribeToSidebarReorderMediaQuery(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }

  const mediaQuery = window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY)
  mediaQuery.addEventListener("change", onChange)
  return () => mediaQuery.removeEventListener("change", onChange)
}

function getSidebarReorderMediaQuerySnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true
  }

  return window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY).matches
}

function useSidebarReorderEnabled() {
  return useSyncExternalStore(
    subscribeToSidebarReorderMediaQuery,
    getSidebarReorderMediaQuerySnapshot,
    () => true
  )
}

function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.bottom,
    view: window,
  }))
}

type RectLookup = {
  get(id: UniqueIdentifier): ClientRect | undefined
}

function getRectCenterY(rect: Pick<ClientRect, "top" | "height">) {
  return rect.top + rect.height / 2
}

function NewConversationButton({
  localPath,
  workspaceTitle,
  onNewLocalChat,
  isConnected,
  startingLocalPath,
}: {
  localPath: string
  workspaceTitle: string
  onNewLocalChat: (localPath: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}) {
  const disabled = !isConnected || startingLocalPath === localPath

  return (
    <button
      type="button"
      disabled={disabled}
      title={!isConnected ? `Start ${APP_NAME} to connect` : "New conversation"}
      data-stillon-part="new-conversation"
      aria-label={`New conversation with ${workspaceTitle}`}
      className={cn(
        "mx-3 mb-3 flex min-h-9 w-[calc(100%-24px)] items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-not-allowed opacity-50"
      )}
      onClick={() => onNewLocalChat(localPath)}
    >
      {startingLocalPath === localPath ? <Loader2 className="size-4 animate-spin" /> : <MessageCirclePlus className="size-4" />}
      New conversation
    </button>
  )
}

function ProjectUnreadIndicator({ projectTitle }: { projectTitle: string }) {
  return (
    <span
      role="img"
      aria-label={`${projectTitle} has unread sessions`}
      title="Unread sessions"
      className="relative flex size-3.5 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="absolute size-2.5 rounded-full bg-emerald-400/80 motion-safe:animate-ping"
      />
      <span
        aria-hidden="true"
        className="size-2.5 rounded-full bg-emerald-400 ring-2 ring-muted/20 dark:ring-muted/50"
      />
    </span>
  )
}

export function getProjectGroupReorderPreviewTargetId({
  activeId,
  groupIds,
  collisionRect,
  droppableRects,
}: {
  activeId: string
  groupIds: string[]
  collisionRect: Pick<ClientRect, "top">
  droppableRects: RectLookup
}) {
  const activeIndex = groupIds.indexOf(activeId)
  if (activeIndex === -1) return null

  const activeRect = droppableRects.get(activeId)
  if (!activeRect) return null

  const previewTriggerY = collisionRect.top + DRAG_REORDER_TRIGGER_OFFSET_PX

  if (collisionRect.top > activeRect.top) {
    for (let index = groupIds.length - 1; index > activeIndex; index--) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY >= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  if (collisionRect.top < activeRect.top) {
    for (let index = 0; index < activeIndex; index++) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY <= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  return activeId
}

const SortableProjectGroup = memo(function SortableProjectGroup({
  group,
  isReorderEnabled,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  isConnected,
  actionsEnabled,
  startingLocalPath,
}: SortableProjectGroupProps) {
  const { groupKey, localPath, title } = group
  const [avatarOpen, setAvatarOpen] = useState(false)
  const projectTitle = title || getPathBasename(localPath)
  const isExpanded = expandedGroups.has(groupKey)
  const isEmptyProject = group.chats.length === 0
  const hasUnreadChat = group.chats.some((chat) => chat.unread)
  const hasMore = group.olderChats.length > 0
  const hasProjectMenu = actionsEnabled && Boolean(onHideProject && onCopyPath && onOpenExternalPath)

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupKey, disabled: !isReorderEnabled })

  const style = {
    transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null),
    transition: isDragging ? undefined : transition,
  }

  const collapsed = collapsedSections.has(groupKey)
  const header = (
    <div
      data-stillon-part="project-header"
      className={cn(
        "relative z-10 flex items-center gap-1 p-3",
        isReorderEnabled && "md:cursor-grab md:active:cursor-grabbing md:select-none md:touch-none",
        isDragging && "cursor-grabbing"
      )}
      onPointerDown={event => { if (isReorderEnabled) listeners?.onPointerDown?.(event) }}
    >
      {isReorderEnabled ? <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-label={`Reorder ${projectTitle} workspace`} className="absolute left-0.5 top-1/2 z-20 hidden size-3 -translate-y-1/2 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 group-hover/section:opacity-60 focus-visible:opacity-100 md:flex"><GripVertical className="size-3" /></button> : null}
      <button type="button" onClick={() => onToggleSection(groupKey)} aria-expanded={!collapsed} aria-label={`${projectTitle} workspace`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <WorkspaceAvatar workspaceId={groupKey} className="size-10 shrink-0" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold leading-5">{projectTitle}</span><span className="block text-[10px] leading-4 text-muted-foreground">Workspace</span></span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>{localPath}</TooltipContent>
        </Tooltip>
        {hasUnreadChat ? <ProjectUnreadIndicator projectTitle={projectTitle} /> : null}
        <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
      </button>
      {collapsed && onNewLocalChat ? <Button variant="outline" size="icon" className="size-8 shrink-0 rounded-lg" title="New conversation" aria-label={`New conversation with ${projectTitle}`} disabled={!isConnected || startingLocalPath === localPath} onClick={() => onNewLocalChat(localPath)}>{startingLocalPath === localPath ? <Loader2 className="size-4 animate-spin" /> : <MessageCirclePlus className="size-4" />}</Button> : null}
      {hasProjectMenu ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0 rounded-lg text-muted-foreground" title="Workspace options" aria-label={`${projectTitle} workspace options`} onClick={openContextMenuFromButton}><MoreHorizontal className="size-4" /></Button></TooltipTrigger><TooltipContent side="right" sideOffset={4}>Workspace options</TooltipContent></Tooltip> : null}
    </div>
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-stillon-part="workspace-card"
      data-workspace-id={groupKey}
      className={cn(
        "group/section mb-3 overflow-hidden rounded-2xl border border-border/70 bg-background/60",
        isDragging && "opacity-50 shadow-lg z-50 relative"
      )}
    >
      {hasProjectMenu ? (
        <ProjectSectionMenu
          onRename={() => onRenameProject?.(groupKey, group.sidebarTitle, group.realTitle || getPathBasename(localPath))}
          onCopyPath={() => onCopyPath?.(localPath)}
          onShowArchived={() => onShowArchivedProject?.(groupKey)}
          onOpenInFinder={() => onOpenExternalPath?.("open_finder", localPath)}
          onHide={() => onHideProject?.(groupKey)}
          onCustomizeAvatar={() => setAvatarOpen(true)}
        >
          {header}
        </ProjectSectionMenu>
      ) : header}

      {!collapsed && onNewLocalChat ? <NewConversationButton localPath={localPath} workspaceTitle={projectTitle} onNewLocalChat={onNewLocalChat} isConnected={isConnected} startingLocalPath={startingLocalPath} /> : null}
      {!collapsed && !isEmptyProject && (group.previewChats.length > 0 || hasMore) && (
        <div data-stillon-part="workspace-conversations" className="mb-3 ml-7 mr-2 space-y-1 border-l-2 border-border/70 pl-2">
            <>
              {group.previewChats.map(renderChatRow)}
              {hasMore && isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-2 justify-center"
                >
                 Show less
                </button>
              ) : null}
              {isExpanded ? group.olderChats.map(renderChatRow) : null}
              {hasMore && !isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-1 justify-center"
                >
                 Show more
                </button>
              ) : null}
            </>
        </div>
      )}
      <WorkspaceAvatarPicker workspaceId={groupKey} title={projectTitle} open={avatarOpen} onOpenChange={setAvatarOpen} />
    </div>
  )
})

const LocalProjectsSectionImpl = function LocalProjectsSection({
  projectGroups,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  onReorderGroups,
  isConnected,
  actionsEnabled = true,
  startingLocalPath,
}: Props) {
  const keyboardDrag = useRef(false)
  useEffect(() => {
    const reload = () => { void useWorkspaceAvatarsStore.getState().reload() }
    reload()
    window.addEventListener("focus", reload)
    return () => window.removeEventListener("focus", reload)
  }, [])
  const supportsSidebarReorder = useSidebarReorderEnabled()
  const isReorderEnabled = actionsEnabled && supportsSidebarReorder
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 2 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const groupIds = useMemo(
    () => projectGroups.map((g) => g.groupKey),
    [projectGroups]
  )

  const collisionDetection = useMemo<CollisionDetection>(() => (args) => {
    if (keyboardDrag.current) return closestCenter(args)
    const overId = getProjectGroupReorderPreviewTargetId({
      activeId: String(args.active.id),
      groupIds,
      collisionRect: args.collisionRect,
      droppableRects: args.droppableRects,
    })

    if (!overId) {
      return closestCenter(args)
    }

    const overContainer = args.droppableContainers.find(
      (container) => container.id === overId
    )

    if (!overContainer) {
      return closestCenter(args)
    }

    return [
      {
        id: overContainer.id,
        data: {
          droppableContainer: overContainer,
          value: 0,
        },
      },
    ]
  }, [groupIds])

  function handleDragEnd(event: DragEndEvent) {
    keyboardDrag.current = false
    if (!isReorderEnabled) return

    const { active, over } = event

    if (over && active.id !== over.id && onReorderGroups) {
      const oldIndex = groupIds.indexOf(active.id as string)
      const newIndex = groupIds.indexOf(over.id as string)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(groupIds, oldIndex, newIndex)
        onReorderGroups(newOrder)
      }
    }
  }

  return (
    <DndContext
      onDragStart={event => { keyboardDrag.current = event.activatorEvent.type === "keydown" }}
      onDragCancel={() => { keyboardDrag.current = false }}
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
        {projectGroups.map((group) => (
        <SortableProjectGroup
          key={group.groupKey}
          group={group}
          isReorderEnabled={isReorderEnabled}
          collapsedSections={collapsedSections}
          expandedGroups={expandedGroups}
          onToggleSection={onToggleSection}
          onToggleExpandedGroup={onToggleExpandedGroup}
          renderChatRow={renderChatRow}
          onShowArchivedProject={onShowArchivedProject}
          onNewLocalChat={onNewLocalChat}
          onCopyPath={onCopyPath}
          onOpenExternalPath={onOpenExternalPath}
          onRenameProject={onRenameProject}
          onHideProject={onHideProject}
          isConnected={actionsEnabled && isConnected}
          actionsEnabled={actionsEnabled}
          startingLocalPath={startingLocalPath}
        />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export const LocalProjectsSection = memo(LocalProjectsSectionImpl)
