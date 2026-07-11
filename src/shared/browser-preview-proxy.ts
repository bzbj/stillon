export const BROWSER_PREVIEW_PROXY_PREFIX = "/api/browser-proxy"

export function isLoopbackPreviewHost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
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

  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return address
  }

  const currentUrl = currentLocation instanceof URL
    ? currentLocation
    : new URL(currentLocation.href)
  if (isLoopbackPreviewHost(currentUrl.hostname)) {
    return address
  }

  return `${BROWSER_PREVIEW_PROXY_PREFIX}/${port}${parsed.pathname}${parsed.search}${parsed.hash}`
}
