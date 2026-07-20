import { isLoopbackPreviewHost } from "../../shared/browser-preview-proxy"
import { isLocalHtmlPreviewPath, isLocalMarkdownPreviewPath } from "../../shared/local-file-urls"
import type { OpenExternalAction } from "../../shared/protocol"

export function shouldBypassInAppLocalFilePreview(hostname: string) {
  return isLoopbackPreviewHost(hostname)
}

export function resolveDirectLocalFileAction(
  filePath: string,
  requestedAction: OpenExternalAction | undefined,
): OpenExternalAction | undefined {
  return isLocalHtmlPreviewPath(filePath) || isLocalMarkdownPreviewPath(filePath)
    ? "open_default"
    : requestedAction
}
