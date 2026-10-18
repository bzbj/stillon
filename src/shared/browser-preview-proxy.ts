import { CONNECT_PREVIEW_START_PREFIX, CONNECT_PREVIEW_UNSUPPORTED_PATH, isConnectHostAuthority } from "./connect-preview"

export const BROWSER_PREVIEW_PROXY_PREFIX = "/api/browser-proxy"

export function isLoopbackPreviewHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}

export function parseLoopbackPreviewUrl(address: string | null | undefined): URL | null {
  if (!address) return null
  try {
    // Markdown serializers percent-encode the brackets around IPv6 literals.
    const parsed = new URL(address.replace(/^(https?:\/\/)%5b::1%5d(?=[:/?#]|$)/iu, "$1[::1]"))
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isLoopbackPreviewHost(parsed.hostname) && !parsed.username && !parsed.password
      && parsed.port !== "0"
      ? parsed : null
  } catch {
    return null
  }
}

export function buildBrowserPreviewProxyUrl(address: string, currentLocation: Location | URL = window.location) {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    return address
  }

  if (!isLoopbackPreviewHost(parsed.hostname)) {
    return address
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return address
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return address
  }

  const currentUrl = currentLocation instanceof URL
    ? currentLocation
    : new URL(currentLocation.href)
  if (isLoopbackPreviewHost(currentUrl.hostname)) {
    return address
  }

  if (isConnectHostAuthority(currentUrl.host)) {
    if (parsed.protocol === "https:") return CONNECT_PREVIEW_UNSUPPORTED_PATH
    return `${CONNECT_PREVIEW_START_PREFIX}/${port}${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  return `${BROWSER_PREVIEW_PROXY_PREFIX}/${port}${parsed.pathname}${parsed.search}${parsed.hash}`
}
