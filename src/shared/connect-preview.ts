export const CONNECT_PREVIEW_START_PREFIX = "/_connect/preview"
export const CONNECT_PREVIEW_PROXY_PREFIX = "/api/connect-preview"
export const CONNECT_PREVIEW_CLAIM_PATH = "/_connect/claim-preview"
export const CONNECT_PREVIEW_UNSUPPORTED_PATH = "/_connect/preview-unsupported"

export function parseConnectPreviewPath(pathname: string, prefix = CONNECT_PREVIEW_PROXY_PREFIX) {
  if (!pathname.startsWith(prefix + "/")) return null
  const match = /^([1-9]\d{0,4})(\/.*)?$/.exec(pathname.slice(prefix.length + 1))
  if (!match || Number(match[1]) > 65535) return null
  return { port: Number(match[1]), path: match[2] ?? "/" }
}

export function connectPreviewOrigin(accountOrigin: string, hostId: string, port: number) {
  if (!/^[a-f0-9]{32}$/.test(hostId) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview target")
  const url = new URL(accountOrigin)
  url.hostname = `p-${hostId}-${port}.${url.hostname}`
  return url.origin
}

export function connectPreviewTarget(accountOrigin: string, authority: string) {
  const suffix = "." + new URL(accountOrigin).host
  if (!authority.endsWith(suffix)) return null
  const match = /^p-([a-f0-9]{32})-([1-9]\d{0,4})$/.exec(authority.slice(0, -suffix.length))
  return match && Number(match[2]) <= 65535 ? { hostId: match[1]!, port: Number(match[2]) } : null
}

export function isConnectHostAuthority(authority: string) {
  return /^h-[a-f0-9]{32}\./.test(authority)
}

export function isConnectCookie(name: string) {
  return /^(?:__Host-)?stillon-connect\./i.test(name)
}
