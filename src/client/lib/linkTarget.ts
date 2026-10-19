import { parseLoopbackPreviewUrl } from "../../shared/browser-preview-proxy"
import { parseLocalFileLink, parseProjectRelativeFileLink, type ParsedLocalFileLink } from "./pathUtils"
import { parsePreviewTarget } from "../../shared/preview-target"
import { normalizeProjectPreviewAddress } from "../../shared/project-file-urls"

export type LinkTarget = { kind: "file"; file: ParsedLocalFileLink; address?: string } | { kind: "service"; address: string }
  | { kind: "external" | "internal" | "other"; address: string }

export function resolveLinkTarget(href: string | null | undefined, context: {
  localPath?: string | null; currentOrigin?: string; projectId?: string; resolveFile?: (href: string) => ParsedLocalFileLink | null
} = {}): LinkTarget | null {
  if (!href || /[\u0000-\u001f\u007f]/u.test(href)) return null
  if (/^https?:/iu.test(href)) {
    try {
      if (context.projectId && context.currentOrigin) {
        const normalized = normalizeProjectPreviewAddress(href, context.projectId, context.currentOrigin)
        if (normalized !== href) return resolveLinkTarget(normalized, context)
      }
      const url = parseLoopbackPreviewUrl(href) ?? new URL(href)
      if (url.username || url.password || url.port === "0") return null
      if (url.origin === context.currentOrigin && /^\/(?:preview\/|api\/)/u.test(url.pathname)) return resolveLinkTarget(url.pathname + url.search + url.hash, context)
      const service = parseLoopbackPreviewUrl(href)
      return service ? { kind: "service", address: service.href } : { kind: "external", address: href }
    } catch { return null }
  }
  if (/^\/(?:preview\/|api\/|_connect\/)/u.test(href) || /^[#?]/u.test(href)) {
    const preview = parsePreviewTarget(href)
    return preview && "filePath" in preview && preview.filePath ? { kind: "file", file: { path: preview.filePath }, address: href } : { kind: "internal", address: href }
  }
  const file = context.resolveFile?.(href) ?? parseLocalFileLink(href) ?? parseProjectRelativeFileLink(href, context.localPath)
  if (file) return { kind: "file", file }
  return /^(?:javascript|data|vbscript):/iu.test(href) ? null : { kind: "other", address: href }
}
