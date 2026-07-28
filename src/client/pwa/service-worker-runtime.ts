import { SERVICE_WORKER_ACTIVATE_MESSAGE } from "../../shared/service-worker-protocol"

export const APP_SHELL_CACHE_PREFIX = "stillon-app-shell-"
export const APP_SHELL_CACHE_KEY_PATH = "/__stillon_app_shell__"
export const APP_SHELL_NAVIGATION_TIMEOUT_MS = 3_000

interface CacheLike {
  delete(request: RequestInfo | URL): Promise<boolean>
  match(request: RequestInfo | URL): Promise<Response | undefined>
  put(request: RequestInfo | URL, response: Response): Promise<void>
}

interface CacheStorageLike {
  delete(cacheName: string): Promise<boolean>
  keys(): Promise<string[]>
  open(cacheName: string): Promise<CacheLike>
}

export interface AppShellWorkerDependencies {
  caches: CacheStorageLike
  fetch: typeof fetch
  claimClients: () => Promise<void>
  skipWaiting: () => Promise<void>
}

export interface AppShellWorkerConfig {
  assetDigests: Record<string, string>
  buildId: string
  origin: string
  precacheUrls: string[]
  runtimeAssetUrls: string[]
  shellDigest: string
  navigationTimeoutMs?: number
}

export type AppShellRequestKind = "navigation" | "asset" | null

function isAppRoute(pathname: string) {
  return pathname === "/"
    || /^\/chat\/[^/]+$/.test(pathname)
    || pathname === "/settings"
    || /^\/settings\/[^/]+$/.test(pathname)
}

export function classifyAppShellRequest(
  request: Pick<Request, "method" | "url" | "mode" | "headers">,
  origin: string,
  runtimeAssetUrls: ReadonlySet<string>,
): AppShellRequestKind {
  if (request.method !== "GET" || request.headers.has("range")) return null

  const url = new URL(request.url)
  if (url.origin !== origin) return null

  if (!url.search && !url.hash && runtimeAssetUrls.has(url.pathname)) {
    return "asset"
  }

  if (request.mode === "navigate" && isAppRoute(url.pathname)) {
    return "navigation"
  }

  return null
}

function expectedContentType(pathname: string) {
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return /(?:java|ecma)script/i
  if (pathname.endsWith(".css")) return /^text\/css$/i
  if (pathname.endsWith(".woff2")) return /^(?:font\/woff2|application\/font-woff2)$/i
  if (pathname.endsWith(".woff")) return /^(?:font\/woff|application\/font-woff)$/i
  if (pathname.endsWith(".svg")) return /^image\/svg\+xml$/i
  if (pathname.endsWith(".json")) return /^(?:application|text)\/json$/i
  if (/\.(?:avif|gif|jpe?g|png|webp)$/.test(pathname)) return /^image\//i
  return null
}

function isSafeSameOriginResponse(response: Response, origin: string) {
  if (response.status !== 200 || response.redirected) return false
  if (response.type === "opaque" || response.type === "opaqueredirect") return false
  if (!response.url) return true
  return new URL(response.url).origin === origin
}

export function isSafeAssetResponse(response: Response, assetUrl: string, origin: string) {
  if (!isSafeSameOriginResponse(response, origin)) return false
  const expected = expectedContentType(new URL(assetUrl, origin).pathname)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? ""
  return expected !== null && expected.test(contentType)
}

function hasExpectedShellMarker(html: string, buildId: string) {
  const escapedBuildId = buildId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const markerPattern = new RegExp(
    `<meta\\s+name=["']stillon-app-shell["']\\s+content=["']${escapedBuildId}["']\\s*\\/?>`,
    "i",
  )
  return markerPattern.test(html)
}

export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

async function responseMatchesDigest(response: Response, expectedDigest: string) {
  return await sha256Hex(await response.clone().arrayBuffer()) === expectedDigest
}

async function createSanitizedResponse(response: Response) {
  const contentType = response.headers.get("content-type")
  const headers = new Headers()
  if (contentType) headers.set("Content-Type", contentType)
  headers.set("X-Content-Type-Options", "nosniff")
  return new Response(await response.clone().arrayBuffer(), {
    status: 200,
    headers,
  })
}

const SHELL_SECURITY_HEADERS = [
  "Content-Security-Policy",
  "Content-Security-Policy-Report-Only",
  "Cross-Origin-Embedder-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
  "Origin-Agent-Cluster",
  "Permissions-Policy",
  "Referrer-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
] as const

function createSanitizedShellResponse(response: Response, html: string) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  for (const headerName of SHELL_SECURITY_HEADERS) {
    const value = response.headers.get(headerName)
    if (value) headers.set(headerName, value)
  }
  return new Response(html, {
    status: 200,
    headers,
  })
}

function createOfflineResponse() {
  return new Response(
    "<!doctype html><title>Still On is offline</title><p>Reconnect to this computer and try again.</p>",
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  )
}

async function fetchNavigationWithTimeout(
  request: Request,
  fetchImpl: typeof fetch,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) {
    forwardAbort()
  } else {
    request.signal.addEventListener("abort", forwardAbort, { once: true })
  }
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort(new DOMException("Navigation probe timed out", "TimeoutError"))
  }, timeoutMs)

  try {
    return await fetchImpl(new Request(request, {
      signal: controller.signal,
    }))
  } finally {
    globalThis.clearTimeout(timeoutId)
    request.signal.removeEventListener("abort", forwardAbort)
  }
}

function isSafeCachedShellResponse(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  return response.status === 200
    && contentType.includes("text/html")
    && response.headers.get("x-content-type-options")?.toLowerCase() === "nosniff"
}

export function createAppShellWorkerRuntime(
  config: AppShellWorkerConfig,
  dependencies: AppShellWorkerDependencies,
) {
  const origin = new URL(config.origin).origin
  const cacheName = `${APP_SHELL_CACHE_PREFIX}${config.buildId}`
  const shellCacheKey = new URL(APP_SHELL_CACHE_KEY_PATH, origin).href
  const precacheUrls = [...new Set(config.precacheUrls)].sort()
  const runtimeAssetUrls = new Set(config.runtimeAssetUrls)
  const navigationTimeoutMs = config.navigationTimeoutMs ?? APP_SHELL_NAVIGATION_TIMEOUT_MS

  async function install() {
    await dependencies.caches.delete(cacheName)
    const cache = await dependencies.caches.open(cacheName)

    try {
      for (const assetPath of precacheUrls) {
        if (!runtimeAssetUrls.has(assetPath)) {
          throw new Error(`Precache URL is absent from the runtime allowlist: ${assetPath}`)
        }
        const expectedDigest = config.assetDigests[assetPath]
        if (!expectedDigest) {
          throw new Error(`Precache URL is missing an integrity digest: ${assetPath}`)
        }

        const assetUrl = new URL(assetPath, origin).href
        const response = await dependencies.fetch(new Request(assetUrl, {
          cache: "reload",
          credentials: "same-origin",
        }))
        if (!isSafeAssetResponse(response, assetUrl, origin)) {
          throw new Error(`Refused unsafe app-shell asset response: ${assetPath}`)
        }
        const sanitizedResponse = await createSanitizedResponse(response)
        if (!await responseMatchesDigest(sanitizedResponse, expectedDigest)) {
          throw new Error(`App-shell asset integrity check failed: ${assetPath}`)
        }
        await cache.put(assetUrl, sanitizedResponse)
      }

      const shellUrl = new URL("/", origin).href
      const shellResponse = await dependencies.fetch(new Request(shellUrl, {
        cache: "reload",
        credentials: "same-origin",
        headers: {
          Accept: "text/html",
        },
      }))
      const contentType = shellResponse.headers.get("content-type")?.toLowerCase() ?? ""
      if (!isSafeSameOriginResponse(shellResponse, origin) || !contentType.includes("text/html")) {
        throw new Error("Refused unsafe app-shell HTML response")
      }

      const shellHtml = await shellResponse.text()
      if (!hasExpectedShellMarker(shellHtml, config.buildId)) {
        throw new Error("App-shell HTML build marker does not match the service worker")
      }
      const cachedShell = createSanitizedShellResponse(shellResponse, shellHtml)
      if (!await responseMatchesDigest(cachedShell, config.shellDigest)) {
        throw new Error("App-shell HTML integrity check failed")
      }
      await cache.put(shellCacheKey, cachedShell)
    } catch (error) {
      await dependencies.caches.delete(cacheName)
      throw error
    }
  }

  async function activate() {
    const cacheNames = await dependencies.caches.keys()
    await Promise.all(cacheNames.map(async (candidate) => {
      if (candidate.startsWith(APP_SHELL_CACHE_PREFIX) && candidate !== cacheName) {
        await dependencies.caches.delete(candidate)
      }
    }))
    await dependencies.claimClients()
  }

  function handleFetch(request: Request): Promise<Response> | null {
    const kind = classifyAppShellRequest(request, origin, runtimeAssetUrls)
    if (kind === null) return null

    if (kind === "navigation") {
      return (async () => {
        let networkResponse: Response | null = null
        try {
          networkResponse = await fetchNavigationWithTimeout(
            request,
            dependencies.fetch,
            navigationTimeoutMs,
          )
          if (networkResponse.status < 500) return networkResponse
        } catch {
          // A verified cached shell is the offline fallback.
        }

        const cache = await dependencies.caches.open(cacheName)
        const cachedShell = await cache.match(shellCacheKey)
        if (cachedShell) {
          if (
            isSafeCachedShellResponse(cachedShell)
            && await responseMatchesDigest(cachedShell, config.shellDigest)
          ) {
            return cachedShell
          }
          await cache.delete(shellCacheKey)
        }
        return networkResponse ?? createOfflineResponse()
      })()
    }

    return (async () => {
      const requestUrl = new URL(request.url)
      const assetUrl = new URL(requestUrl.pathname, origin).href
      const cache = await dependencies.caches.open(cacheName)
      const cachedAsset = await cache.match(assetUrl)
      const expectedDigest = config.assetDigests[requestUrl.pathname]
      if (cachedAsset && expectedDigest) {
        if (
          isSafeAssetResponse(cachedAsset, assetUrl, origin)
          && await responseMatchesDigest(cachedAsset, expectedDigest)
        ) {
          return cachedAsset
        }
        await cache.delete(assetUrl)
      }

      const response = await dependencies.fetch(request)
      if (!isSafeAssetResponse(response, assetUrl, origin)) {
        return response
      }

      const sanitizedResponse = await createSanitizedResponse(response)
      if (!expectedDigest || !await responseMatchesDigest(sanitizedResponse, expectedDigest)) {
        return new Response("Static asset integrity check failed", {
          status: 502,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        })
      }
      await cache.put(assetUrl, sanitizedResponse)
      return response
    })()
  }

  function handleMessage(data: unknown) {
    if (
      typeof data === "object"
      && data !== null
      && "type" in data
      && data.type === SERVICE_WORKER_ACTIVATE_MESSAGE
    ) {
      return dependencies.skipWaiting()
    }
    return undefined
  }

  return {
    cacheName,
    shellCacheKey,
    install,
    activate,
    handleFetch,
    handleMessage,
  }
}
