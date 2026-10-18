import { fileRenderer } from "../../shared/file-renderers"
import { isLoopbackPreviewHost } from "../../shared/browser-preview-proxy"
import type { OpenExternalAction } from "../../shared/protocol"

export type LocalFileLinkAction = OpenExternalAction | "download"

export type TranscriptLocalFileDisposition = "preview" | "open_host" | "download" | "blocked"

export function canOpenTranscriptFilesOnHost(hostname: string) {
  return isLoopbackPreviewHost(hostname)
}

export function resolveTranscriptLocalFileDisposition(args: {
  hostname: string
  filePath: string
  isProjectFile: boolean
}): TranscriptLocalFileDisposition {
  if (fileRenderer(args.filePath)) {
    return "preview"
  }
  if (canOpenTranscriptFilesOnHost(args.hostname)) {
    return "open_host"
  }
  return "download"
}
