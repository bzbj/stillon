import { defaultWorkspaceStatusBadges, defaultWorkspaceAvatars, workspaceAvatarChoice, type WorkspaceAvatarChoice, type WorkspaceAvatars } from "../../shared/workspace-avatars"
import { useWorkspaceAvatarsStore } from "../stores/workspaceAvatarsStore"
import { cn } from "../lib/utils"
import { useOptionalAppearance } from "../hooks/useAppearance"

export function AvatarArtwork({ config, choice, className, label }: {
  config: WorkspaceAvatars; choice: WorkspaceAvatarChoice; className?: string; label?: string
}) {
  const shape = config.shapes.find(shape => shape.id === choice.shape) ?? config.shapes[0]!
  return <svg viewBox="0 0 64 64" className={className} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} data-avatar-shape={shape.id} data-avatar-color={choice.color}>
    <path d={shape.body} fill={choice.color} />
    <path d={shape.eyes} fill="none" stroke="#fff" strokeWidth={shape.eyeWidth} strokeLinecap="round" />
  </svg>
}

export interface WorkspaceActivity {
  working: boolean
  unreadResult: boolean
  attention: boolean
}

export function WorkspaceAvatar({ workspaceId, className, activity, label = "Workspace" }: {
  workspaceId: string; className?: string; activity?: WorkspaceActivity; label?: string
}) {
  const saved = useWorkspaceAvatarsStore(state => state.config)
  const safeMode = useOptionalAppearance()?.safeMode
  const config = safeMode ? defaultWorkspaceAvatars() : saved
  const artwork = <AvatarArtwork config={config} choice={workspaceAvatarChoice(config, workspaceId)} className={activity ? "size-full" : className} />
  if (!activity) return artwork
  const badges = config.statusBadges ?? defaultWorkspaceStatusBadges()
  const topBadge = activity.working ? "working" : activity.attention ? "attention" : null
  const badge = (kind: keyof typeof badges, description: string) => (
    <span key={kind} data-stillon-part="workspace-avatar-status" data-status={kind} role="img" aria-label={description} title={description}
      style={{ backgroundColor: badges[kind].background, color: badges[kind].foreground }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d={badges[kind].mark} fill="none" stroke="currentColor" strokeWidth={kind === "complete" ? 2.3 : 2.8} strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  )
  return <span data-stillon-part="workspace-avatar" className={cn("relative inline-flex overflow-visible", className)}>
    {artwork}
    {topBadge ? badge(topBadge, activity.working ? `${label} is working` : `${label} needs your attention`) : null}
    {activity.unreadResult ? badge("complete", `${label} has new results to read`) : null}
  </span>
}
