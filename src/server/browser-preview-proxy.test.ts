import { describe, expect, test } from "bun:test"
import {
  handleBrowserPreviewProxy,
  parseBrowserPreviewProxyTarget,
  rewritePreviewLocationHeader,
  rewritePreviewResponseText,
  rewriteRootRelativeReferences,
} from "./browser-preview-proxy"

describe("browser preview proxy", () => {
  test("parses preview proxy targets", () => {
    expect(parseBrowserPreviewProxyTarget("/api/browser-proxy/5173/src/main.ts")).toEqual({
      port: 5173,
      path: "/src/main.ts",
    })
    expect(parseBrowserPreviewProxyTarget("/api/browser-proxy/nope")).toBeNull()
    expect(parseBrowserPreviewProxyTarget("/api/browser-proxy/70000/")).toBeNull()
  })

  test("rewrites common localhost and root-relative references", () => {
    const rewritten = rewritePreviewResponseText(
      [
        '<script type="module" src="/src/main.ts"></script>',
        '<link href="/assets/app.css" rel="stylesheet">',
        '<a href="http://localhost:5173/page">Page</a>',
        "body { background: url('/bg.png') }",
        'import "/@vite/client"',
      ].join("\n"),
      5173
    )

    expect(rewritten).toContain('src="/api/browser-proxy/5173/src/main.ts"')
    expect(rewritten).toContain('href="/api/browser-proxy/5173/assets/app.css"')
    expect(rewritten).toContain('href="/api/browser-proxy/5173/page"')
    expect(rewritten).toContain("url('/api/browser-proxy/5173/bg.png')")
    expect(rewritten).toContain('import "/api/browser-proxy/5173/@vite/client"')
  })

  test("rewrites root-relative static document resources without duplicating an existing prefix", () => {
    const prefix = "/api/projects/project-1/preview"
    const rewritten = rewriteRootRelativeReferences(
      [
        '<img src="/images/chart.png">',
        '<img srcset="/images/small.png 1x, /images/large.png 2x">',
        '<a href="/api/projects/project-1/preview/already.html">Existing</a>',
        "body { background: url('/images/bg.png') }",
      ].join("\n"),
      prefix,
    )

    expect(rewritten).toContain(`src="${prefix}/images/chart.png"`)
    expect(rewritten).toContain(`srcset="${prefix}/images/small.png 1x, ${prefix}/images/large.png 2x"`)
    expect(rewritten).toContain(`href="${prefix}/already.html"`)
    expect(rewritten).toContain(`url('${prefix}/images/bg.png')`)
  })

  test("rewrites absolute localhost redirect locations", () => {
    expect(rewritePreviewLocationHeader("http://localhost:5173/login?next=%2F", 5173))
      .toBe("/api/browser-proxy/5173/login?next=%2F")
    expect(rewritePreviewLocationHeader("/login", 5173)).toBe("/login")
  })

  test("proxies allowed preview ports and relaxes frame-blocking headers", async () => {
    let requestedUrl = ""
    let forwardedHeaders = new Headers()
    const response = await handleBrowserPreviewProxy(
      new Request("https://stillon.example.com/api/browser-proxy/5173/", {
        headers: {
          Authorization: "Bearer private",
          Cookie: "stillon_session=private",
          Origin: "https://stillon.example.com",
          Referer: "https://stillon.example.com/chat/demo",
          "CF-Connecting-IP": "203.0.113.10",
          "X-Forwarded-For": "203.0.113.10",
        },
      }),
      new URL("https://stillon.example.com/api/browser-proxy/5173/"),
      {
        isAllowedPort: async (port) => port === 5173,
        fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requestedUrl = String(url)
          forwardedHeaders = new Headers(init?.headers)
          return new Response('<script src="/src/main.ts"></script>', {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Length": "39",
              "X-Frame-Options": "DENY",
              "Content-Security-Policy": "frame-ancestors 'none'",
              "Set-Cookie": "preview_token=private",
            },
          })
        }) as unknown as typeof fetch,
      }
    )

    expect(response).not.toBeNull()
    expect(requestedUrl).toBe("http://127.0.0.1:5173/")
    expect(forwardedHeaders.get("authorization")).toBeNull()
    expect(forwardedHeaders.get("cookie")).toBeNull()
    expect(forwardedHeaders.get("referer")).toBeNull()
    expect(forwardedHeaders.get("cf-connecting-ip")).toBeNull()
    expect(forwardedHeaders.get("x-forwarded-for")).toBeNull()
    expect(forwardedHeaders.get("origin")).toBe("http://127.0.0.1:5173")
    expect(response!.headers.get("x-frame-options")).toBeNull()
    expect(response!.headers.get("content-security-policy")).toBeNull()
    expect(response!.headers.get("content-length")).toBeNull()
    expect(response!.headers.get("set-cookie")).toBeNull()
    expect(await response!.text()).toBe('<script src="/api/browser-proxy/5173/src/main.ts"></script>')
  })

  test("rejects unavailable preview ports before proxying", async () => {
    let didFetch = false
    const response = await handleBrowserPreviewProxy(
      new Request("https://stillon.example.com/api/browser-proxy/9999/"),
      new URL("https://stillon.example.com/api/browser-proxy/9999/"),
      {
        isAllowedPort: async () => false,
        fetchImpl: (async () => {
          didFetch = true
          return new Response("unreachable")
        }) as unknown as typeof fetch,
      }
    )

    expect(response?.status).toBe(404)
    expect(didFetch).toBe(false)
  })

  test("cancels an in-flight upstream request when the server lifecycle is aborted", async () => {
    const lifecycle = new AbortController()
    let markUpstreamStarted!: () => void
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve
    })
    let upstreamWasAborted = false
    const responsePromise = handleBrowserPreviewProxy(
      new Request("https://stillon.example.com/api/browser-proxy/5173/hang"),
      new URL("https://stillon.example.com/api/browser-proxy/5173/hang"),
      {
        signal: lifecycle.signal,
        isAllowedPort: async () => true,
        fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const upstreamSignal = init?.signal
          if (!upstreamSignal) throw new Error("Missing upstream abort signal")
          markUpstreamStarted()
          return await new Promise<Response>((_resolve, reject) => {
            upstreamSignal.addEventListener("abort", () => {
              upstreamWasAborted = true
              reject(upstreamSignal.reason ?? new DOMException("Aborted", "AbortError"))
            }, { once: true })
          })
        }) as unknown as typeof fetch,
      },
    )

    await upstreamStarted
    lifecycle.abort(new DOMException("Server shutting down", "AbortError"))

    await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" })
    expect(upstreamWasAborted).toBe(true)
  })
})
