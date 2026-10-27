/** Connect-only routing. Never mutates the service or provider environment. */
export type ConnectRoute = "direct" | "proxy"
export type ConnectNetworkFailure = "DNS_FAILED" | "CONNECTION_FAILED" | "TIMEOUT" | "TLS_FAILED"
export type ConnectFailureStage = "api" | "tunnel" | "direct-probe"
const proxyKeys = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy"])

export function transportEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !proxyKeys.has(key.toLowerCase())))
}
function environmentValue(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name.toLowerCase()]?.trim() || environment[name]?.trim() || ""
}
export function bypassesProxy(url: URL, entries: string): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return entries.split(/[\s,]+/).filter(Boolean).some(raw => {
    if (raw === "*") return true
    let entry = raw.toLowerCase(), entryPort = ""
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry)
    if (match) { entry = match[1]; entryPort = match[2] }
    if (entryPort && port !== entryPort) return false
    entry = entry.replace(/^\[|\]$/g, "").replace(/^\*?\./, "")
    return host === entry || (!entry.includes(":") && host.endsWith(`.${entry}`))
  })
}
export function networkFailure(caught: unknown): ConnectNetworkFailure | null {
  const error = caught as { code?: unknown; name?: unknown; cause?: unknown } | null
  if (!error || typeof error !== "object") return null
  const code = String(error.code ?? "").toUpperCase()
  if (/CERT|TLS|SSL|SELF_SIGNED|ISSUER|ALTNAME|VERIFY|SIGNATURE/.test(code)) return "TLS_FAILED"
  if (error.name === "TimeoutError" || ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "TIMEOUT"
  if (["ENOTFOUND", "EAI_AGAIN", "DNS_ENOTFOUND", "DNS_EAI_AGAIN"].includes(code)) return "DNS_FAILED"
  if (["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET", "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket"].map(value => value.toUpperCase()).includes(code)) return "CONNECTION_FAILED"
  return error.cause && error.cause !== caught ? networkFailure(error.cause) : null
}

export function createConnectRouting(origin: string, environment: NodeJS.ProcessEnv = process.env, now = Date.now) {
  const authority = new URL(origin)
  const bypass = environmentValue(environment, "NO_PROXY")
  const rawProxy = (authority.protocol === "https:" ? environmentValue(environment, "HTTPS_PROXY") : "")
    || environmentValue(environment, "HTTP_PROXY") || environmentValue(environment, "ALL_PROXY")
  let proxy: string | undefined
  let proxyIssue: "PROXY_INVALID" | "PROXY_UNSUPPORTED" | undefined
  if (rawProxy) {
    try {
      const parsed = new URL(rawProxy)
      // HTTP CONNECT is shared by the API client and the bundled frpc. Do not let
      // either runtime silently reinterpret an unsupported proxy scheme.
      if (parsed.protocol !== "http:") proxyIssue = "PROXY_UNSUPPORTED"
      else if (parsed.pathname !== "/" || parsed.search || parsed.hash) proxyIssue = "PROXY_INVALID"
      else { decodeURIComponent(parsed.username); decodeURIComponent(parsed.password); proxy = parsed.href }
    } catch { proxyIssue = "PROXY_INVALID" }
  }
  let route: ConnectRoute = "direct", version = 0, failures = 0, nextProbe = 0
  let tunnel: URL | undefined
  let lastFailure: { route: ConnectRoute; stage: ConnectFailureStage; code: string } | null = null
  const allowed = () => !bypassesProxy(authority, bypass) && (!tunnel || !bypassesProxy(tunnel, bypass))
  function select(next: ConnectRoute) { if (route !== next) { route = next; version++ }; nextProbe = now() + 5 * 60_000 }
  return {
    get route() { return route },
    get version() { return version },
    get proxy() { return route === "proxy" ? proxy! : "" },
    get retryDelay() { return Math.min(60_000, 5_000 * 2 ** Math.min(Math.max(0, failures - 1), 4)) },
    setTunnel(url: URL) { tunnel = url; if (route === "proxy" && !allowed()) select("direct") },
    fail(stage: ConnectFailureStage, code: string, expectedVersion = version) {
      if (expectedVersion !== version) return false
      lastFailure = { route, stage, code }; failures++
      // Trust/auth/application errors must never change routes.
      if (!["DNS_FAILED", "CONNECTION_FAILED", "TIMEOUT", "TUNNEL_TIMEOUT", "TUNNEL_DISCONNECTED"].includes(code)) return false
      if (route === "direct" && proxy && allowed()) { select("proxy"); return true }
      if (route === "proxy") { select("direct"); return true }
      return false
    },
    online() { failures = 0 },
    probeDue() { return route === "proxy" && now() >= nextProbe },
    probeResult(ok: boolean) { nextProbe = now() + 5 * 60_000; if (ok) select("direct") },
    diagnostics() { return { mode: "auto" as const, route, proxyAvailable: Boolean(proxy) && allowed(),
      ...(proxyIssue ? { proxyError: proxyIssue } : {}), lastFailure } },
  }
}

/** Retain only a fixed error category, never a raw frpc log line. */
export function transportFailure(text: string): ConnectNetworkFailure | null {
  if (/x509:|certificate|tls handshake|tls:|unknown authority/i.test(text)) return "TLS_FAILED"
  if (/no such host|name resolution|lookup .+ (?:failed|timeout)/i.test(text)) return "DNS_FAILED"
  if (/timed? out|timeout/i.test(text)) return "TIMEOUT"
  if (/connection refused|network is unreachable|connection reset/i.test(text)) return "CONNECTION_FAILED"
  return null
}
