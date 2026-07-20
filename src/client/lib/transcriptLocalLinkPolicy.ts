import { isLoopbackPreviewHost } from "../../shared/browser-preview-proxy"
import { isLocalHtmlPreviewPath, isLocalMarkdownPreviewPath } from "../../shared/local-file-urls"

export type TranscriptLocalFileDisposition = "preview" | "open_host" | "download" | "blocked"

export function canOpenTranscriptFilesOnHost(hostname: string) {
  return isLoopbackPreviewHost(hostname)
}

export function resolveTranscriptLocalFileDisposition(args: {
  hostname: string
  filePath: string
  isProjectFile: boolean
}): TranscriptLocalFileDisposition {
  if (isLocalHtmlPreviewPath(args.filePath) || isLocalMarkdownPreviewPath(args.filePath)) {
    return "preview"
  }
  if (canOpenTranscriptFilesOnHost(args.hostname)) {
    return "open_host"
  }
  return args.isProjectFile ? "download" : "blocked"
}
