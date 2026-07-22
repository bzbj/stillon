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
  const withLoopbackUrlsRewritten = text
    .replace(new RegExp(`https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|["'\\s)<]|$)`, "g"), prefix)
    .replace(new RegExp(`//(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|["'\\s)<]|$)`, "g"), prefix)
  return rewriteRootRelativeReferences(withLoopbackUrlsRewritten, prefix)
}

export function rewriteRootRelativeReferences(text: string, rawPrefix: string) {
  const prefix = rawPrefix.replace(/\/+$/, "")
  const withPrefix = (value: string) => {
    const absolutePath = `/${value}`
    return absolutePath === prefix || absolutePath.startsWith(`${prefix}/`)
      ? absolutePath
      : `${prefix}${absolutePath}`
  }

  return text
    .replace(
      /((?:src|href|action|poster|data|formaction|xlink:href)=["'])\/(?!\/)([^"']*)/gi,
      (_match, attribute: string, value: string) => `${attribute}${withPrefix(value)}`,
    )
    .replace(/(srcset=["'])([^"']*)/gi, (_match, attribute: string, value: string) => (
      `${attribute}${value.replace(/(^|,\s*)\/(?!\/)([^,\s]+)/g, (_entry, separator: string, pathValue: string) => (
        `${separator}${withPrefix(pathValue)}`
      ))}`
    ))
    .replace(
      /(url\(\s*["']?)\/(?!\/)([^"')]+)/gi,
      (_match, opener: string, value: string) => `${opener}${withPrefix(value)}`,
    )
    .replace(
      /(@import\s+(?:url\()?["'])\/(?!\/)([^"']+)/gi,
      (_match, opener: string, value: string) => `${opener}${withPrefix(value)}`,
    )
    .replace(
      /(\b(?:from|import)\s*\(?\s*["'])\/(?!\/)([^"']+)/g,
      (_match, opener: string, value: string) => `${opener}${withPrefix(value)}`,
    )
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

function buildForwardHeaders(req: Request, port: number) {
  const headers = new Headers(req.headers)
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  for (const header of [...headers.keys()]) {
    const lower = header.toLowerCase()
    if (
      lower === "authorization"
      || lower === "cookie"
      || lower === "referer"
      || lower === "x-real-ip"
      || lower.startsWith("cf-")
      || lower.startsWith("x-forwarded-")
      || lower.startsWith("sec-fetch-")
    ) {
      headers.delete(header)
    }
  }
  if (headers.has("origin")) {
    headers.set("origin", `http://127.0.0.1:${port}`)
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
  headers.delete("set-cookie")
  headers.delete("set-cookie2")

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
    signal?: AbortSignal
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
  const upstreamSignal = options.signal
    ? AbortSignal.any([req.signal, options.signal])
    : req.signal
  const upstreamResponse = await fetchImpl(upstreamUrl, {
    method: req.method,
    headers: buildForwardHeaders(req, target.port),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
    signal: upstreamSignal,
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
