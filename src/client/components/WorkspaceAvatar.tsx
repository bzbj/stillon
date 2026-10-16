import { defaultWorkspaceAvatars, workspaceAvatarChoice, type WorkspaceAvatarChoice, type WorkspaceAvatars } from "../../shared/workspace-avatars"
import { useWorkspaceAvatarsStore } from "../stores/workspaceAvatarsStore"
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

export function WorkspaceAvatar({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const saved = useWorkspaceAvatarsStore(state => state.config)
  const safeMode = useOptionalAppearance()?.safeMode
  const config = safeMode ? defaultWorkspaceAvatars() : saved
  return <AvatarArtwork config={config} choice={workspaceAvatarChoice(config, workspaceId)} className={className} />
}
