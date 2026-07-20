import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LOCAL_HTML_PREVIEW_SESSION_ENDPOINT } from "../shared/local-file-urls"
import { createLocalHtmlPreviewManager } from "./local-html-preview"
import { startStillOnServer } from "./server"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("local HTML previews", () => {
  test("serves an explicitly authorized HTML directory through a sandboxed capability URL", async () => {
    const previewDir = await mkdtemp(path.join(tmpdir(), "stillon-local-html-"))
    const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-local-html-data-"))
    const outsideDir = await mkdtemp(path.join(tmpdir(), "stillon-local-html-outside-"))
    tempDirs.push(previewDir, dataDir, outsideDir)
    await mkdir(path.join(previewDir, "assets"), { recursive: true })
    await writeFile(
      path.join(previewDir, "index.html"),
      "<!doctype html><title>Outside project</title><script src=\"./assets/app.js\"></script><img src=\"/assets/chart.png\">",
      "utf8",
    )
    await writeFile(path.join(previewDir, "assets", "app.js"), "document.body.dataset.ready = '1'", "utf8")
    await writeFile(path.join(previewDir, "assets", "chart.png"), new Uint8Array([137, 80, 78, 71]))
    await writeFile(path.join(previewDir, ".env"), "SECRET=do-not-serve", "utf8")
    await writeFile(path.join(outsideDir, "outside.js"), "globalThis.stolen = true", "utf8")
    if (process.platform !== "win32") {
      await symlink(path.join(outsideDir, "outside.js"), path.join(previewDir, "assets", "outside.js"))
    }

    const server = await startStillOnServer({
      dataDir,
      port: 4490,
      strictPort: false,
      openBrowser: false,
    })

    try {
      const origin = `http://127.0.0.1:${server.port}`
      const remoteCreateResponse = await fetch(`${origin}${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "stillon.example.com" },
        body: JSON.stringify({ filePath: path.join(previewDir, "index.html") }),
      })
      expect(remoteCreateResponse.status).toBe(403)

      const createResponse = await fetch(`${origin}${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: path.join(previewDir, "index.html") }),
      })
      expect(createResponse.status).toBe(201)
      const payload = await createResponse.json() as { url: string, expiresAt: number }
      const sessionRootUrl = payload.url.slice(0, payload.url.lastIndexOf("/") + 1)
      expect(payload.url).toMatch(/^\/api\/local-html-previews\/[A-Za-z0-9_-]+\/index\.html$/)
      expect(payload.expiresAt).toBeGreaterThan(Date.now())

      const htmlResponse = await fetch(`${origin}${payload.url}`)
      expect(htmlResponse.status).toBe(200)
      expect(htmlResponse.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(htmlResponse.headers.get("cache-control")).toBe("no-store")
      expect(htmlResponse.headers.get("referrer-policy")).toBe("no-referrer")
      expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff")
      expect(htmlResponse.headers.get("permissions-policy")).toContain("camera=()")
      const csp = htmlResponse.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("sandbox allow-scripts")
      expect(csp).not.toContain("allow-same-origin")
      const previewHtml = await htmlResponse.text()
      expect(previewHtml).toContain("Outside project")
      expect(previewHtml).toContain(`${sessionRootUrl}assets/chart.png`)

      const scriptUrl = new URL("./assets/app.js", `${origin}${payload.url}`)
      const scriptResponse = await fetch(scriptUrl)
      expect(scriptResponse.status).toBe(200)
      expect(scriptResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(await scriptResponse.text()).toContain("dataset.ready")

      const secretResponse = await fetch(`${origin}${sessionRootUrl}.env`)
      expect(secretResponse.status).toBe(403)
      expect(await secretResponse.text()).not.toContain("do-not-serve")

      const traversalResponse = await fetch(`${origin}${sessionRootUrl}..%2Foutside.js`)
      expect(traversalResponse.status).toBe(400)

      if (process.platform !== "win32") {
        const symlinkEscapeResponse = await fetch(`${origin}${sessionRootUrl}assets/outside.js`)
        expect(symlinkEscapeResponse.status).toBe(403)
        expect(await symlinkEscapeResponse.text()).not.toContain("stolen")
      }
    } finally {
      await server.stop()
    }
  })

  test("requires local-only binding or authentication before issuing capabilities", async () => {
    const manager = createLocalHtmlPreviewManager({ createToken: () => "test-token" })
    try {
      const request = new Request(`http://example.test${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "/tmp/index.html" }),
      })
      const response = await manager.handleRequest(request, new URL(request.url), { allowCreate: false })
      expect(response?.status).toBe(403)
    } finally {
      manager.dispose()
    }
  })

  test("expires capability URLs", async () => {
    const previewDir = await mkdtemp(path.join(tmpdir(), "stillon-local-html-expiry-"))
    tempDirs.push(previewDir)
    const htmlPath = path.join(previewDir, "index.html")
    await writeFile(htmlPath, "<!doctype html><title>Expiring</title>", "utf8")

    let currentTime = 1_000
    const manager = createLocalHtmlPreviewManager({
      ttlMs: 100,
      now: () => currentTime,
      createToken: () => "test-token",
    })
    try {
      const createRequest = new Request(`http://localhost${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: htmlPath }),
      })
      const createResponse = await manager.handleRequest(createRequest, new URL(createRequest.url), { allowCreate: true })
      const payload = await createResponse?.json() as { url: string }

      currentTime = 1_101
      const previewRequest = new Request(`http://localhost${payload.url}`)
      const previewResponse = await manager.handleRequest(previewRequest, new URL(previewRequest.url), { allowCreate: true })
      expect(previewResponse?.status).toBe(410)
    } finally {
      manager.dispose()
    }
  })
})
