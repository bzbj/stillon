import { parseLoopbackPreviewUrl } from "./browser-preview-proxy"
import { isLoopbackPreviewHost } from "./browser-preview-proxy"
import { parseLocalMarkdownPreviewUrl, parseLocalFilePreviewUrl } from "./local-file-urls"
import { fileRenderer } from "./file-renderers"
import { parseProjectFilePreviewUrl, parseProjectMarkdownPreviewUrl } from "./project-file-urls"

export type PreviewTarget =
  | { kind: "project-file"; address: string; projectId: string; filePath: string; markdown: boolean; canonicalPath?: string; directory?: boolean }
  | { kind: "host-file"; address: string; filePath: string; markdown: boolean; canonicalPath?: string; directory?: boolean }
  | { kind: "host-html"; address: string; filePath?: string; canonicalPath?: string }
  | { kind: "host-http" | "external-http"; address: string }

export function parsePreviewTarget(address: string, projectId?: string): PreviewTarget | null {
  if (!address || address.length > 32_768 || /[\u0000-\u001f]/u.test(address)) return null
  if (address.startsWith("/") && !address.startsWith("//")) {
    const md = parseProjectMarkdownPreviewUrl(address)
    const file = md ?? parseProjectFilePreviewUrl(address)
    if (file) {
      if (projectId && file.projectId !== projectId) return null
      if (file.filePath.split(/[\\/]/u).some(p => p === ".." || p === ".")) return null
      return { kind: "project-file", address, ...file, markdown: Boolean(md) }
    }
    const local = parseLocalMarkdownPreviewUrl(address)
    if (local) return { kind: "host-file", address, ...local, markdown: true }
    const host = parseLocalFilePreviewUrl(address)
    if (host) return { kind: "host-file", address, ...host, markdown: fileRenderer(host.filePath) === "markdown" }
    if (/^\/api\/local-html-previews\/[A-Za-z0-9_-]+\/[^?#]+(?:[?#].*)?$/u.test(address)) return { kind: "host-html", address }
    return null
  }
  try {
    const url = parseLoopbackPreviewUrl(address) ?? new URL(address)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
    return { kind: parseLoopbackPreviewUrl(url.href) ? "host-http" : "external-http", address: url.href }
  } catch { return null }
}

export function standalonePreviewUrl(id: string) { return `/preview/${encodeURIComponent(id)}` }
export function isGrantedPreviewNavigation(target: PreviewTarget, address: string, virtualOrigin?: string) {
  try {
    const url = new URL(address)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false
    if (virtualOrigin) return url.origin === virtualOrigin
    if (isLoopbackPreviewHost(url.hostname)) return target.kind === "host-http" && url.origin === new URL(target.address).origin
    return true // The network proxy separately validates/pins every public destination.
  } catch { return false }
}
export function isPlainPreviewClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}
