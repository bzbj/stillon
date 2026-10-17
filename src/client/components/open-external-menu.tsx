import { Download, Eye, FolderOpen, SquareArrowOutUpRight } from "lucide-react"
import type { OpenExternalAction } from "../../shared/protocol"
import { ContextMenuContent, ContextMenuItem } from "./ui/context-menu"

type FileAction = "preview" | "open_default" | "download" | "open_finder"
export function fileActionItems({ local, isMac, preview, download }: {
  local: boolean; isMac: boolean; preview: boolean; download: boolean
}): Array<{action: FileAction; label: string}> {
  return [
    ...(preview ? [{ action: "preview" as const, label: "Preview in sidebar" }] : []),
    ...(local ? [{ action: "open_default" as const, label: "Open on this computer" }] : []),
    ...(download ? [{ action: "download" as const, label: "Download" }] : []),
    ...(local ? [{ action: "open_finder" as const, label: isMac ? "Show in Finder" : "Show in folder" }] : []),
  ]
}
const icons = {preview: Eye, open_default: SquareArrowOutUpRight, download: Download, open_finder: FolderOpen}

export function OpenExternalContextMenuContent({
  isMac, onOpenExternal, onPreview, onDownload,
}: {
  isMac: boolean
  onOpenExternal: (action: OpenExternalAction) => void
  onPreview?: () => void
  onDownload?: () => void
}) {
  const items = fileActionItems({local:true,isMac,preview:Boolean(onPreview),download:Boolean(onDownload)})
  return <ContextMenuContent className="rounded-lg p-1">
    {items.map(({action,label}) => {
      const Icon=icons[action]
      return <ContextMenuItem key={action} onSelect={event => {
        event.preventDefault()
        if(action==="preview") onPreview?.()
        else if(action==="download") onDownload?.()
        else onOpenExternal(action)
      }}><Icon className="size-4" />{label}</ContextMenuItem>
    })}
  </ContextMenuContent>
}
