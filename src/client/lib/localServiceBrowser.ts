import { isLoopbackPreviewHost, parseLoopbackPreviewUrl } from "../../shared/browser-preview-proxy"

// The visiting browser must itself be on the host. A loopback destination in
// Connect refers to the remote computer, not the visiting device.
export function localServiceBrowserAddress(address: string, hostname = typeof window === "undefined" ? "" : window.location.hostname): string | null {
  if (!isLoopbackPreviewHost(hostname)) return null
  return parseLoopbackPreviewUrl(address)?.href ?? null
}

export function openLocalServiceInBrowser(address: string): boolean {
  const direct = localServiceBrowserAddress(address)
  if (!direct) return false
  window.open(direct, "_blank", "noopener,noreferrer")
  return true
}
