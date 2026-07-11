import { listLocalHttpServers } from "./local-http-servers"
import { BROWSER_PREVIEW_PROXY_PREFIX, isLoopbackPreviewHost } from "../shared/browser-preview-proxy"

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const REWRITABLE_CONTENT_TYPES = [
  "text/html",
  "text/css",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/json",
]

export interface BrowserPreviewProxyTarget {
  port: number
  path: string
}

export function parseBrowserPreviewProxyTarget(pathname: string): BrowserPreviewProxyTarget | null {
  const escapedPrefix = BROWSER_PREVIEW_PROXY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = pathname.match(new RegExp(`^${escapedPrefix}/(\\d+)(/.*)?$`))
  if (!match) return null

  const port = Number(match[1])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }

  return {
    port,
    path: match[2] ?? "/",
  }
}

export function rewritePreviewResponseText(text: string, port: number) {
  const prefix = `${BROWSER_PREVIEW_PROXY_PREFIX}/${port}`
  return text
    .replace(new RegExp(`https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|["'\\s)<]|$)`, "g"), prefix)
    .replace(new RegExp(`//(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|["'\\s)<]|$)`, "g"), prefix)
    .replace(/((?:src|href|action|poster|data|formaction|xlink:href)=["'])\/(?!\/|api\/browser-proxy\/)/gi, `$1${prefix}/`)
    .replace(/(srcset=["'][^"']*)\/(?!\/|api\/browser-proxy\/)/gi, `$1${prefix}/`)
    .replace(/(url\(\s*["']?)\/(?!\/|api\/browser-proxy\/)/gi, `$1${prefix}/`)
    .replace(/(@import\s+(?:url\()?["'])\/(?!\/|api\/browser-proxy\/)/gi, `$1${prefix}/`)
    .replace(/(\b(?:from|import)\s*\(?\s*["'])\/(?!\/|api\/browser-proxy\/)/g, `$1${prefix}/`)
}

export function rewritePreviewLocationHeader(location: string, port: number) {
  const prefix = `${BROWSER_PREVIEW_PROXY_PREFIX}/${port}`
  try {
    const parsed = new URL(location)
    if (isLoopbackPreviewHost(parsed.hostname) && Number(parsed.port) === port) {
      return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Relative redirects already resolve against the proxied path in the browser.
  }
  return location
}

export async function isAllowedBrowserPreviewPort(port: number, blockedPorts: Iterable<number> = []) {
  if ([...blockedPorts].includes(port)) return false
  const servers = await listLocalHttpServers()
  return servers.some((server) => server.port === port && server.status >= 200 && server.status < 400)
}

function shouldRewriteResponse(headers: Headers) {
  const contentType = headers.get("content-type")?.toLowerCase() ?? ""
  return REWRITABLE_CONTENT_TYPES.some((candidate) => contentType.includes(candidate))
}

function buildForwardHeaders(req: Request) {
  const headers = new Headers(req.headers)
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  return headers
}

function buildResponseHeaders(upstreamHeaders: Headers, port: number) {
  const headers = new Headers(upstreamHeaders)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("x-frame-options")
  headers.delete("content-security-policy")
  headers.delete("content-security-policy-report-only")
  headers.delete("cross-origin-opener-policy")
  headers.delete("cross-origin-embedder-policy")

  const location = headers.get("location")
  if (location) {
    headers.set("location", rewritePreviewLocationHeader(location, port))
  }

  return headers
}

export async function handleBrowserPreviewProxy(
  req: Request,
  url: URL,
  options: {
    blockedPorts?: Iterable<number>
    fetchImpl?: typeof fetch
    isAllowedPort?: (port: number) => Promise<boolean>
  } = {}
) {
  const target = parseBrowserPreviewProxyTarget(url.pathname)
  if (!target) return null

  if (url.pathname === `${BROWSER_PREVIEW_PROXY_PREFIX}/${target.port}`) {
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${BROWSER_PREVIEW_PROXY_PREFIX}/${target.port}/${url.search}${url.hash}`,
      },
    })
  }

  const isAllowedPort = options.isAllowedPort
    ?? ((port: number) => isAllowedBrowserPreviewPort(port, options.blockedPorts))
  if (!await isAllowedPort(target.port)) {
    return Response.json({ error: "Preview port is not available." }, { status: 404 })
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const upstreamUrl = `http://127.0.0.1:${target.port}${target.path}${url.search}`
  const upstreamResponse = await fetchImpl(upstreamUrl, {
    method: req.method,
    headers: buildForwardHeaders(req),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  })
  const headers = buildResponseHeaders(upstreamResponse.headers, target.port)

  if (!shouldRewriteResponse(upstreamResponse.headers)) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    })
  }

  const text = await upstreamResponse.text()
  return new Response(rewritePreviewResponseText(text, target.port), {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  })
}
