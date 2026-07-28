import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SERVICE_WORKER_ACTIVATE_MESSAGE } from "../../shared/service-worker-protocol"
import {
  APP_SHELL_CACHE_PREFIX,
  classifyAppShellRequest,
  createAppShellWorkerRuntime,
} from "./service-worker-runtime"

const ORIGIN = "https://stillon.test"
const BUILD_ID = "0123456789abcdefabcd"
const SCRIPT_PATH = "/assets/index-AAAAAAAA.js"
const STYLE_PATH = "/assets/index-BBBBBBBB.css"

function normalizeRequestKey(request: RequestInfo | URL) {
  const raw = request instanceof Request ? request.url : String(request)
  return new URL(raw, ORIGIN).href
}

class MemoryCache {
  readonly entries = new Map<string, Response>()

  async match(request: RequestInfo | URL) {
    return this.entries.get(normalizeRequestKey(request))?.clone()
  }

  async delete(request: RequestInfo | URL) {
    return this.entries.delete(normalizeRequestKey(request))
  }

  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(normalizeRequestKey(request), response.clone())
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>()
  readonly deleted: string[] = []

  async open(cacheName: string) {
    let cache = this.stores.get(cacheName)
    if (!cache) {
      cache = new MemoryCache()
      this.stores.set(cacheName, cache)
    }
    return cache
  }

  async keys() {
    return [...this.stores.keys()]
  }

  async delete(cacheName: string) {
    this.deleted.push(cacheName)
    return this.stores.delete(cacheName)
  }
}

function assetResponse(pathname: string, body = pathname) {
  const contentType = pathname.endsWith(".css")
    ? "text/css"
    : pathname.endsWith(".woff2")
      ? "font/woff2"
      : "text/javascript"
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Set-Cookie": "private=never-cache",
    },
  })
}

function shellHtml(buildId = BUILD_ID) {
  return `<!doctype html><html><head><meta name="stillon-app-shell" content="${buildId}" /></head><body></body></html>`
}

function shellResponse(buildId = BUILD_ID) {
  return new Response(shellHtml(buildId), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": "private=never-cache",
    },
  })
}

function digest(body: string) {
  return createHash("sha256").update(body).digest("hex")
}

function createHarness(
  fetchImpl?: typeof fetch,
  configOverrides: Partial<Parameters<typeof createAppShellWorkerRuntime>[0]> = {},
) {
  const caches = new MemoryCacheStorage()
  const fetchCalls: string[] = []
  let claimCount = 0
  let skipWaitingCount = 0
  const runtime = createAppShellWorkerRuntime(
    {
      assetDigests: {
        [SCRIPT_PATH]: digest(SCRIPT_PATH),
        [STYLE_PATH]: digest(STYLE_PATH),
        "/assets/chat-CCCCCCCC.js": digest("/assets/chat-CCCCCCCC.js"),
      },
      buildId: BUILD_ID,
      origin: ORIGIN,
      precacheUrls: [SCRIPT_PATH, STYLE_PATH],
      runtimeAssetUrls: [SCRIPT_PATH, STYLE_PATH, "/assets/chat-CCCCCCCC.js"],
      shellDigest: digest(shellHtml()),
      ...configOverrides,
    },
    {
      caches,
      fetch: fetchImpl ?? (async (request) => {
        const url = new URL(request instanceof Request ? request.url : String(request), ORIGIN)
        fetchCalls.push(url.href)
        return url.pathname.startsWith("/assets/") ? assetResponse(url.pathname) : shellResponse()
      }) as typeof fetch,
      claimClients: async () => {
        claimCount += 1
      },
      skipWaiting: async () => {
        skipWaitingCount += 1
      },
    },
  )
  return {
    caches,
    fetchCalls,
    runtime,
    get claimCount() {
      return claimCount
    },
    get skipWaitingCount() {
      return skipWaitingCount
    },
  }
}

describe("app-shell service-worker runtime", () => {
  test("installs only the eager shell and strips response-private headers", async () => {
    const harness = createHarness()
    await harness.runtime.install()

    const cache = harness.caches.stores.get(harness.runtime.cacheName)!
    expect([...cache.entries.keys()].sort()).toEqual([
      `${ORIGIN}${SCRIPT_PATH}`,
      `${ORIGIN}${STYLE_PATH}`,
      harness.runtime.shellCacheKey,
    ].sort())
    expect(harness.fetchCalls).toEqual([
      `${ORIGIN}${SCRIPT_PATH}`,
      `${ORIGIN}${STYLE_PATH}`,
      `${ORIGIN}/`,
    ])
    for (const response of cache.entries.values()) {
      expect(response.headers.get("set-cookie")).toBeNull()
    }
    expect(cache.entries.get(harness.runtime.shellCacheKey)?.headers.get("content-security-policy"))
      .toBe("default-src 'self'")
    expect(cache.entries.get(harness.runtime.shellCacheKey)?.headers.get("referrer-policy"))
      .toBe("no-referrer")
  })

  test("fails atomically on an unsafe asset or mismatched shell", async () => {
    const oldName = `${APP_SHELL_CACHE_PREFIX}old-build`
    const unsafeAssetHarness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname === STYLE_PATH) {
        return new Response("<!doctype html>login", {
          headers: { "Content-Type": "text/html" },
        })
      }
      return url.pathname === "/" ? shellResponse() : assetResponse(url.pathname)
    }) as typeof fetch)
    await unsafeAssetHarness.caches.open(oldName)

    await expect(unsafeAssetHarness.runtime.install()).rejects.toThrow("unsafe app-shell asset")
    expect(unsafeAssetHarness.caches.stores.has(unsafeAssetHarness.runtime.cacheName)).toBe(false)
    expect(unsafeAssetHarness.caches.stores.has(oldName)).toBe(true)

    const wrongShellHarness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      return url.pathname === "/" ? shellResponse("ffffffffffffffffffff") : assetResponse(url.pathname)
    }) as typeof fetch)
    await expect(wrongShellHarness.runtime.install()).rejects.toThrow("build marker")
    expect(wrongShellHarness.caches.stores.has(wrongShellHarness.runtime.cacheName)).toBe(false)
  })

  test("activates by cleaning only owned old caches, then claims clients", async () => {
    const harness = createHarness()
    await harness.caches.open(harness.runtime.cacheName)
    await harness.caches.open(`${APP_SHELL_CACHE_PREFIX}old-one`)
    await harness.caches.open(`${APP_SHELL_CACHE_PREFIX}old-two`)
    await harness.caches.open("other-product-cache")

    await harness.runtime.activate()

    expect(await harness.caches.keys()).toEqual([
      harness.runtime.cacheName,
      "other-product-cache",
    ])
    expect(harness.claimCount).toBe(1)
  })

  test("uses live navigation policy online and the verified shell only as an offline fallback", async () => {
    let offline = false
    let installed = false
    const networkPaths: string[] = []
    const harness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname.startsWith("/assets/")) return assetResponse(url.pathname)
      networkPaths.push(url.pathname)
      if (offline) throw new TypeError("offline")
      if (!installed) return shellResponse()
      return new Response("<!doctype html><title>Live policy</title>", {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'none'",
        },
      })
    }) as typeof fetch)
    await harness.runtime.install()
    installed = true

    const online = await harness.runtime.handleFetch(new Request(`${ORIGIN}/chat/chat-123`, {
      mode: "navigate",
    }))
    expect(await online!.text()).toContain("Live policy")
    expect(online!.headers.get("content-security-policy")).toBe("default-src 'none'")

    offline = true
    for (const pathname of ["/", "/chat/chat-123", "/settings", "/settings/welcome?from=pwa"]) {
      const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}${pathname}`, {
        mode: "navigate",
      }))
      expect(response).not.toBeNull()
      expect(await response!.text()).toContain(`content="${BUILD_ID}"`)
    }
    expect(networkPaths).toEqual([
      "/",
      "/chat/chat-123",
      "/",
      "/chat/chat-123",
      "/settings",
      "/settings/welcome",
    ])
  })

  test("returns ingress redirects and denials instead of hiding them behind the shell", async () => {
    const harness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname.startsWith("/assets/")) return assetResponse(url.pathname)
      if (url.pathname === "/") return shellResponse()
      return new Response("Access login required", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      })
    }) as typeof fetch)
    await harness.runtime.install()

    const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}/settings`, {
      mode: "navigate",
    }))
    expect(response?.status).toBe(403)
    expect(await response!.text()).toContain("Access login")
  })

  test("uses exact query-free asset allowlists and never caches HTML pollution", async () => {
    let fetchCount = 0
    const harness = createHarness((async (request) => {
      fetchCount += 1
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname === "/assets/chat-CCCCCCCC.js") {
        return new Response("<!doctype html>SPA fallback", {
          headers: { "Content-Type": "text/html" },
        })
      }
      return url.pathname === "/" ? shellResponse() : assetResponse(url.pathname)
    }) as typeof fetch)
    await harness.runtime.install()
    fetchCount = 0

    const cachedScript = await harness.runtime.handleFetch(new Request(`${ORIGIN}${SCRIPT_PATH}`))
    expect(await cachedScript!.text()).toBe(SCRIPT_PATH)
    expect(fetchCount).toBe(0)

    const polluted = await harness.runtime.handleFetch(new Request(`${ORIGIN}/assets/chat-CCCCCCCC.js`))
    expect(await polluted!.text()).toContain("SPA fallback")
    expect(fetchCount).toBe(1)
    const cache = harness.caches.stores.get(harness.runtime.cacheName)!
    expect(cache.entries.has(`${ORIGIN}/assets/chat-CCCCCCCC.js`)).toBe(false)

    expect(harness.runtime.handleFetch(new Request(`${ORIGIN}${SCRIPT_PATH}?v=other`))).toBeNull()
    expect(harness.runtime.handleFetch(new Request(`${ORIGIN}/assets/not-listed-DDDDDDDD.js`))).toBeNull()
  })

  test("detects and repairs same-origin Cache Storage poisoning before executing an asset", async () => {
    let scriptFetches = 0
    const harness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname === SCRIPT_PATH) scriptFetches += 1
      return url.pathname.startsWith("/assets/") ? assetResponse(url.pathname) : shellResponse()
    }) as typeof fetch)
    await harness.runtime.install()
    scriptFetches = 0

    const cache = harness.caches.stores.get(harness.runtime.cacheName)!
    await cache.put(`${ORIGIN}${SCRIPT_PATH}`, assetResponse(SCRIPT_PATH, "malicious preview script"))
    const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}${SCRIPT_PATH}`))

    expect(await response!.text()).toBe(SCRIPT_PATH)
    expect(scriptFetches).toBe(1)
    expect(await (await cache.match(`${ORIGIN}${SCRIPT_PATH}`))!.text()).toBe(SCRIPT_PATH)
  })

  test("rejects a poisoned offline shell instead of exposing cached attacker HTML", async () => {
    let offline = false
    const harness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname.startsWith("/assets/")) return assetResponse(url.pathname)
      if (offline) throw new TypeError("offline")
      return shellResponse()
    }) as typeof fetch)
    await harness.runtime.install()
    const cache = harness.caches.stores.get(harness.runtime.cacheName)!
    await cache.put(harness.runtime.shellCacheKey, new Response("<script>steal()</script>", {
      headers: { "Content-Type": "text/html" },
    }))
    offline = true

    const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}/chat/chat-123`, {
      mode: "navigate",
    }))
    expect(response?.status).toBe(503)
    expect(await response!.text()).not.toContain("steal")
    expect(cache.entries.has(harness.runtime.shellCacheKey)).toBe(false)
  })

  test("hard-bypasses every dynamic/private request class", () => {
    const harness = createHarness()
    const excludedPaths = [
      "/api/transcripts/chat-123",
      "/api/projects/project-1/uploads",
      "/api/local-files/content/example",
      "/api/local-html-previews/session",
      "/api/browser-proxy/5173/",
      "/auth/status",
      "/auth/login",
      "/auth/logout",
      "/ws",
      "/health",
      "/manifest.webmanifest",
      "/service-worker.js",
      "/unknown",
    ]

    for (const pathname of excludedPaths) {
      expect(harness.runtime.handleFetch(new Request(`${ORIGIN}${pathname}`, {
        mode: "navigate",
      }))).toBeNull()
    }
    expect(harness.runtime.handleFetch(new Request(`${ORIGIN}/api/transcripts`, {
      method: "POST",
    }))).toBeNull()
    expect(harness.runtime.handleFetch(new Request(`https://other.test${SCRIPT_PATH}`))).toBeNull()
    expect(harness.runtime.handleFetch(new Request(`${ORIGIN}${SCRIPT_PATH}`, {
      headers: { Range: "bytes=0-100" },
    }))).toBeNull()
    expect(harness.caches.stores.size).toBe(0)
  })

  test("returns a controlled public offline response when cache storage was evicted", async () => {
    const harness = createHarness((async () => {
      throw new TypeError("offline")
    }) as unknown as typeof fetch)
    const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}/chat/chat-123`, {
      mode: "navigate",
    }))

    expect(response?.status).toBe(503)
    expect(await response!.text()).toContain("Reconnect")
  })

  test("falls back to the verified shell when a navigation probe hangs", async () => {
    let installed = false
    let navigationWasAborted = false
    const harness = createHarness((async (request) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.pathname.startsWith("/assets/")) return assetResponse(url.pathname)
      if (!installed) return shellResponse()
      return await new Promise<Response>((_resolve, reject) => {
        const signal = request instanceof Request ? request.signal : undefined
        signal?.addEventListener("abort", () => {
          navigationWasAborted = true
          reject(signal.reason)
        }, { once: true })
      })
    }) as typeof fetch, {
      navigationTimeoutMs: 5,
    })
    await harness.runtime.install()
    installed = true

    const response = await harness.runtime.handleFetch(new Request(`${ORIGIN}/chat/chat-123`, {
      mode: "navigate",
    }))
    expect(await response!.text()).toContain(`content="${BUILD_ID}"`)
    expect(navigationWasAborted).toBe(true)
  })

  test("only skips waiting for the explicit activation message", async () => {
    const harness = createHarness()

    expect(harness.runtime.handleMessage(null)).toBeUndefined()
    expect(harness.runtime.handleMessage({ type: "unknown" })).toBeUndefined()
    await harness.runtime.handleMessage({ type: SERVICE_WORKER_ACTIVATE_MESSAGE })
    expect(harness.skipWaitingCount).toBe(1)
  })
})

describe("app-shell request classification", () => {
  const assets = new Set([SCRIPT_PATH])

  test("accepts only real app routes", () => {
    expect(classifyAppShellRequest(
      new Request(`${ORIGIN}/chat/id`, { mode: "navigate" }),
      ORIGIN,
      assets,
    )).toBe("navigation")
    for (const pathname of ["/chat", "/chat/id/extra", "/settings/a/b", "/apiary"]) {
      expect(classifyAppShellRequest(
        new Request(`${ORIGIN}${pathname}`, { mode: "navigate" }),
        ORIGIN,
        assets,
      )).toBeNull()
    }
  })
})
