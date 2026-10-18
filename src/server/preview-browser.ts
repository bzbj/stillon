import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { Browser, BrowserContext, CDPSession, ConnectOverCDPTransport, Page } from "playwright"
import type { PreviewTarget } from "../shared/preview-target"
import { isGrantedPreviewNavigation } from "../shared/preview-target"
import { isPreviewResourcePath } from "../shared/preview-navigation"
import { createPreviewNetworkProxy, resolvePreviewNetworkTarget } from "./preview-network"
import { inferPreviewContentType } from "./local-html-preview"
import { protectPreviewPort, releasePreviewPort } from "./preview-ports"
import { CONNECT_LEASE_MS } from "../shared/connect"

export function isWithinPreviewDirectory(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}
interface Session {
  id: string; scope: string; group: string; targetId: string; target: PreviewTarget; context: BrowserContext; page: Page
  proxy?: Awaited<ReturnType<typeof createPreviewNetworkProxy>>; virtualOrigin?: string; originalPrefix?: string
  touched: number; pending: number; tail: Promise<unknown>; error?: string
  lastAddress: string
  navigationType?: "push" | "replace" | "pop"
  viewers: Map<string, number>
  deadline?: number
  input: CDPSession
  pointer?: { viewer: string | null; id: number; type: string; button: "left" | "middle" | "right"; seen: number; releasing?: boolean }
}
class PreviewFramePendingError extends Error {}

export class PreviewBrowser {
  private engine?: Promise<Browser>
  private readonly sessions = new Map<string, Session>()
  private opening = 0
  private stopped = false
  private process?: Bun.Subprocess
  private profile?: string
  private debugPort?: number
  private readonly timer = setInterval(() => {
    for (const session of this.sessions.values()) {
      if (Date.now() - session.touched > 180_000 || (session.deadline !== undefined && performance.now() >= session.deadline)) void this.closeSession(session)
      else if (session.pointer && Date.now() - session.pointer.seen > 5_000) void this.queuePointerRelease(session)
    }
  }, 1_000)
  constructor(private readonly options: {
    blockedPorts: () => Iterable<number>
    resolveFile: (target: PreviewTarget, owner: string) => Promise<string>
  }) { this.timer.unref() }

  private async browser() {
    if (!this.engine) this.engine = (async () => {
      const { chromium } = await import("playwright")
      const candidates = process.env.STILLON_PREVIEW_BROWSER ? [process.env.STILLON_PREVIEW_BROWSER] : [
        chromium.executablePath(),
        ...(process.platform === "win32" ? [
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
          path.join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
        ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
          : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]),
      ]
      const executablePath = (await Promise.all(candidates.map(async file => await Bun.file(file).exists() ? file : null))).find(Boolean)
      if (!executablePath) throw new Error("Install Chrome or Edge on the StillOn computer, or install Playwright Chromium, then retry the preview.")
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value && /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|DISPLAY|XDG_RUNTIME_DIR|LANG|LC_ALL)$/iu.test(name))) as Record<string, string>
      if (process.platform === "win32") {
        // Bun on Windows cannot drive Chromium's extra stdio pipe. A private
        // loopback CDP socket avoids that platform limitation. Browser traffic
        // cannot reach it: it is included in the protected-port registry.
        this.profile = await mkdtemp(path.join(os.tmpdir(), "stillon-preview-browser-"))
        this.process = Bun.spawn([executablePath, "--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
          "--user-data-dir=" + this.profile, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
          "--disable-background-networking", "--disable-component-update", "--disable-quic", "--proxy-bypass-list=<-loopback>",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "about:blank"], { env, stdout: "ignore", stderr: "ignore" })
        const until = Date.now() + 20_000
        while (Date.now() < until && !this.stopped) {
          try {
            const port = Number((await readFile(path.join(this.profile, "DevToolsActivePort"), "utf8")).split("\n")[0])
            if (port > 0 && port < 65536) {
              this.debugPort = port; protectPreviewPort(port)
              const version = await (await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(5_000) })).json() as { webSocketDebuggerUrl: string }
              const endpoint = new URL(version.webSocketDebuggerUrl)
              if (endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port || endpoint.protocol !== "ws:") throw new Error("Invalid private browser endpoint")
              const socket = new WebSocket(endpoint)
              const transport: ConnectOverCDPTransport = { send: message => socket.send(JSON.stringify(message)), close: () => socket.close() }
              socket.addEventListener("message", event => transport.onmessage?.(JSON.parse(String(event.data))))
              socket.addEventListener("close", () => transport.onclose?.())
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { socket.close(); reject(new Error("Preview browser connection timed out")) }, 5_000)
                socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
                socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Preview browser connection failed")) }, { once: true })
              })
              return await chromium.connectOverCDP(transport, { timeout: 10_000 })
            }
          } catch { /* Wait for the private browser listener. */ }
          if (this.process.exitCode !== null) break
          await Bun.sleep(100)
        }
        throw new Error("The preview browser could not start. Check that Chrome or Edge is available and retry.")
      }
      return chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env,
        args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] })
    })().catch(async error => { this.engine = undefined; await this.closeRuntime(); throw error })
    return this.engine
  }

  private async closeSession(session: Session) {
    if (!this.sessions.delete(session.id)) return
    await session.context.close().catch(() => undefined)
    await session.proxy?.close()
  }
  async closeScope(scope: string) {
    await Promise.all([...this.sessions.values()].filter(session => session.scope === scope).map(session => this.closeSession(session)))
  }
  async close() {
    this.stopped = true; clearInterval(this.timer)
    await Promise.all([...this.sessions.values()].map(session => this.closeSession(session)))
    await (await this.engine?.catch(() => undefined))?.close()
    await this.closeRuntime()
  }
  private async closeRuntime() {
    if (this.process && this.process.exitCode === null) { this.process.kill(); await this.process.exited }
    if (this.debugPort) releasePreviewPort(this.debugPort)
    if (this.profile && path.dirname(this.profile) === os.tmpdir() && path.basename(this.profile).startsWith("stillon-preview-browser-")) await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    this.process = undefined; this.profile = undefined; this.debugPort = undefined
  }
  private address(session: Session) {
    if (session.error) return session.lastAddress
    const url = new URL(session.page.url())
    if (!isGrantedPreviewNavigation(session.target, url.href, session.virtualOrigin)) return session.lastAddress
    if (session.virtualOrigin && url.origin === session.virtualOrigin) return session.lastAddress = session.originalPrefix + url.pathname.slice(1) + url.search + url.hash
    return ["http:", "https:"].includes(url.protocol) ? session.lastAddress = url.href : session.lastAddress
  }
  private async releasePointer(session: Session) {
    const pointer = session.pointer
    session.pointer = undefined
    if (!pointer) return
    if (pointer.type === "touch") await session.input.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => undefined)
    else await session.page.mouse.up({ button: pointer.button, clickCount: 0 }).catch(() => undefined)
  }
  private queuePointerRelease(session: Session) {
    const pointer = session.pointer
    if (!pointer || pointer.releasing) return Promise.resolve()
    pointer.releasing = true
    const operation = session.tail.catch(() => undefined).then(async () => { if (session.pointer === pointer) await this.releasePointer(session) })
    session.tail = operation
    return operation
  }
  private async pointerInput(session: Session, viewer: string | null, action: Record<string, unknown>) {
    const { phase, pointerId, pointerType, button, buttons, x, y } = action
    const viewport = session.page.viewportSize()!
    if (!["down", "move", "up", "cancel"].includes(String(phase)) || !Number.isSafeInteger(pointerId) || (pointerId as number) < 0
      || !["mouse", "touch", "pen"].includes(String(pointerType)) || ![0, 1, 2].includes(button as number)
      || !Number.isInteger(buttons) || (buttons as number) < 0 || (buttons as number) > 7
      || typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > viewport.width
      || typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > viewport.height) return false
    const held = session.pointer
    if (phase !== "down" && held && (held.viewer !== viewer || held.id !== pointerId || held.type !== pointerType)) return false
    if (phase === "cancel") { await this.releasePointer(session); return true }
    if (phase === "down") {
      await this.releasePointer(session)
      session.pointer = { viewer, id: pointerId as number, type: String(pointerType), button: (["left", "middle", "right"] as const)[button as number]!, seen: Date.now() }
    } else if (phase === "up" && !held) return true
    else if (held) held.seen = Date.now()
    if (pointerType === "touch") {
      if (!session.pointer) return true
      await session.input.send("Input.dispatchTouchEvent", { type: phase === "down" ? "touchStart" : phase === "up" ? "touchEnd" : "touchMove",
        touchPoints: phase === "up" ? [] : [{ x, y, id: pointerId as number, radiusX: 1, radiusY: 1, force: 1 }] })
    } else {
      await session.page.mouse.move(x, y)
      if (phase === "down") await session.page.mouse.down({ button: session.pointer!.button })
      else if (phase === "up") await session.page.mouse.up({ button: held!.button })
    }
    if (phase === "up") session.pointer = undefined
    return true
  }
  private async load(session: Session, destination: string, forceGet = false) {
    await this.releasePointer(session)
    // Navigating to an identical URL with a fragment can be a same-document
    // jump. Start a fresh document to force GET, including after a POST form.
    if (forceGet) await session.page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 })
    await session.page.goto(destination, { waitUntil: "commit", timeout: 10_000 })
    // A committed response can precede its scripts/forms. Give first-party
    // readiness a bounded grace period without treating a slow site as offline.
    await session.page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined)
  }
  private async capture(session: Session) {
    const cdp = await session.context.newCDPSession(session.page)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: false, fromSurface: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PreviewFramePendingError("The preview is still rendering. Retry shortly.")), 5_000) }),
      ])
      return result.data
    } finally { clearTimeout(timer); await cdp.detach().catch(() => undefined) }
  }
  private async title(session: Session) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([session.page.title(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { void this.closeSession(session); reject(new Error("The preview stopped responding. Retry to reopen it.")) }, 5_000)
      })])
    } finally { clearTimeout(timer) }
  }
  private async open(targetId: string, target: PreviewTarget, owner: string, scope: string, workspace?: string, viewer?: string, reload = false) {
    const file = target.kind === "project-file" || target.kind === "host-html" ? await this.options.resolveFile(target, owner) : undefined
    if (!file) await resolvePreviewNetworkTarget(new URL(target.address), this.options.blockedPorts(), target.kind === "host-http" ? new URL(target.address).origin : undefined)
    const group = (workspace ?? "") + ":" + (file ? path.dirname(file) : new URL(target.address).origin)
    const existing = [...this.sessions.values()].find(session => session.scope === scope && session.group === group)
    if (existing && !existing.page.isClosed()) {
      existing.touched = Date.now()
      if (viewer) existing.viewers.set(viewer, Date.now())
      // A new authenticated open is an explicit service authorization. Page
      // resource requests and passive frame polling cannot renew this grant.
      existing.proxy?.reauthorize()
      const forceGet = reload || Boolean(existing.error)
      if (forceGet || this.address(existing) !== target.address) {
        existing.error = undefined
        existing.lastAddress = target.address
        const location = new URL(target.address, "http://stillon.invalid")
        const destination = existing.virtualOrigin && file ? existing.virtualOrigin + "/" + encodeURIComponent(path.basename(file)) + location.search + location.hash : target.address
        const navigation = existing.tail.catch(() => undefined).then(() => this.load(existing, destination, forceGet)).catch(() => { existing.error = "The page could not be loaded. Check the service and retry." })
        existing.tail = navigation
        await navigation
      }
      return existing
    }
    for (const session of this.sessions.values()) for (const [id, seen] of session.viewers) if (Date.now() - seen > 30_000) session.viewers.delete(id)
    while (this.sessions.size + this.opening >= 8 || [...this.sessions.values()].filter(value => value.scope === scope).length >= 4) {
      const scoped = [...this.sessions.values()].filter(value => value.scope === scope).length >= 4
      const idle = [...this.sessions.values()].filter(value => !value.viewers.size && !value.pending && (!scoped || value.scope === scope)).sort((a, b) => a.touched - b.touched)[0]
      if (!idle) break
      await this.closeSession(idle)
    }
    if (this.stopped || this.sessions.size + this.opening >= 8 || [...this.sessions.values()].filter(value => value.scope === scope).length >= 4) throw new Error("Close another preview before opening a new browser session.")
    this.opening++
    let context: BrowserContext | undefined, proxy: Session["proxy"]
    try {
      const virtualOrigin = file ? `http://${randomBytes(12).toString("hex")}.preview.invalid` : undefined
      proxy = await createPreviewNetworkProxy(this.options.blockedPorts, target.kind === "host-http" ? new URL(target.address).origin : undefined, Boolean(file))
      context = await (await this.browser()).newContext({ viewport: { width: 1100, height: 800 }, proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
        acceptDownloads: false, serviceWorkers: "block", permissions: [] })
      context.setDefaultTimeout(5_000)
      await context.addInitScript(() => {
        // Device and direct peer transports are outside the HTTP preview grant.
        for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Object.defineProperty(globalThis, name, { value: undefined, configurable: false })
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: false })
        const execCommand = Document.prototype.execCommand
        Object.defineProperty(Document.prototype, "execCommand", { configurable: false,
          value: function(this: Document, command: string, showUI?: boolean, value?: string) {
            const name = String(command)
            return /^(?:copy|cut|paste)$/iu.test(name.trim()) ? false : execCommand.call(this, name, showUI, value)
          } })
      })
      const page = await context.newPage()
      const permissions = await context.newCDPSession(page)
      const { targetInfo } = await permissions.send("Target.getTargetInfo")
      if (!targetInfo.browserContextId) throw new Error("The preview browser could not isolate device permissions")
      const deniedOrigins = new Set<string>()
      const denyClipboard = async (origin: string) => {
        if (deniedOrigins.has(origin)) return
        if (deniedOrigins.size >= 64) throw new Error("The preview reached its navigation origin limit. Reopen it to continue.")
        const url = new URL(origin)
        // Insecure file/public HTTP origins cannot use the async clipboard.
        // Chromium rejects permission overrides there; script/legacy guards
        // still apply in every frame.
        if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) { deniedOrigins.add(origin); return }
        for (const name of ["clipboard-read", "clipboard-write"]) await permissions.send("Browser.setPermission", {
          browserContextId: targetInfo.browserContextId, origin,
          permission: { name, allowWithoutSanitization: false, allowWithoutGesture: false }, setting: "denied",
        })
        deniedOrigins.add(origin)
      }
      await denyClipboard(virtualOrigin ?? new URL(target.address).origin)
      const id = randomBytes(24).toString("base64url")
      const session: Session = { id, scope, group, targetId, target, context, page, proxy, virtualOrigin,
        touched: Date.now(), pending: 0, tail: Promise.resolve(), lastAddress: target.address, viewers: new Map(viewer ? [[viewer, Date.now()]] : []), input: permissions }
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) void this.queuePointerRelease(session) })
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && /^https?:\/\//u.test(request.url())) {
          if (isGrantedPreviewNavigation(target, request.url(), virtualOrigin)) {
            const url = new URL(request.url())
            const logical = virtualOrigin ? session.originalPrefix + url.pathname.slice(1) + url.search : url.href
            const previous = new URL(session.lastAddress, "http://stillon.invalid"), next = new URL(logical, "http://stillon.invalid")
            if (previous.origin === next.origin && previous.pathname === next.pathname && previous.search === next.search) next.hash = previous.hash
            session.lastAddress = virtualOrigin ? next.pathname + next.search + next.hash : next.href
          }
          session.error = undefined
        }
      })
      page.on("response", response => {
        if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return
        const transport = response.headers()["x-stillon-preview-transport"]
        if (transport) session.error = transport === "unavailable" ? "The web server is unavailable. Start it on the computer and retry." : "This destination is outside the preview's authorized service. Open its own preview to continue."
      })
      const binding = "__stillonNavigation_" + randomBytes(8).toString("hex")
      await page.exposeBinding(binding, ({ frame }, kind: unknown) => {
        if (frame === page.mainFrame() && ["push", "replace", "pop"].includes(String(kind))) session.navigationType = kind as Session["navigationType"]
      })
      await page.addInitScript(({ binding }) => {
        const report = (kind: string) => { void (window as any)[binding](kind) }
        for (const [method, kind] of [["pushState", "push"], ["replaceState", "replace"]] as const) {
          const original = history[method].bind(history)
          history[method] = (data: unknown, unused: string, url?: string | URL | null) => { original(data, unused, url); report(kind) }
        }
        addEventListener("popstate", () => report("pop"))
        addEventListener("hashchange", () => report("push"))
      }, { binding })
      if (file && virtualOrigin) {
        const root = path.dirname(file)
        const logical = new URL(target.address, "http://stillon.invalid")
        session.originalPrefix = logical.pathname.slice(0, logical.pathname.lastIndexOf("/") + 1)
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url())
          if (url.origin !== virtualOrigin || !["GET", "HEAD"].includes(request.method())) { await route.abort(); return }
          let relative: string
          try { relative = decodeURIComponent(url.pathname.slice(1)) } catch { await route.abort(); return }
          if (!isPreviewResourcePath(relative)) { await route.abort(); return }
          try {
            const resource = await realpath(path.resolve(root, relative)), info = await stat(resource)
            if (!isWithinPreviewDirectory(root, resource) || !info.isFile() || info.size > 25 * 1024 * 1024) { await route.abort(); return }
            const resourceFile = Bun.file(resource)
            await route.fulfill({ status: 200, contentType: inferPreviewContentType(resource, resourceFile.type),
              headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: Buffer.from(await resourceFile.arrayBuffer()) })
          } catch { await route.fulfill({ status: 404, body: "Preview resource not found" }) }
        })
      } else {
        // Chromium proxying handles HTTP(S) and WebSocket connections. Block
        // alternate schemes, local file navigation and browser internals too.
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url())
          if (!["http:", "https:"].includes(url.protocol)) { await route.abort(); return }
          try { if (request.isNavigationRequest()) await denyClipboard(url.origin) }
          catch { await route.abort(); return }
          await route.continue()
        })
      }
      context.on("page", popup => { if (popup !== page) void popup.close() })
      page.on("dialog", dialog => void dialog.dismiss())
      page.on("download", download => void download.cancel())
      this.sessions.set(id, session)
      const destination = file ? virtualOrigin + "/" + encodeURIComponent(path.basename(file)) + new URL(target.address, "http://stillon.invalid").search + new URL(target.address, "http://stillon.invalid").hash : target.address
      await this.load(session, destination!).catch(() => { session.error = "The page could not be loaded. Check the service and retry." })
      return session
    } catch (error) { await context?.close().catch(() => undefined); await proxy?.close(); throw error }
    finally { this.opening-- }
  }

  async handle(request: Request, url: URL, options: { owner: string; scope: string; expiresAt?: number; target: (id: string) => { target: PreviewTarget; projectId?: string } | null }) {
    if (!url.pathname.startsWith("/api/preview-browser")) return null
    try {
      const renew = (session: Session) => {
        if (options.expiresAt === undefined) return
        const remaining = options.expiresAt - Date.now()
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > CONNECT_LEASE_MS + 5_000) throw new Error("Preview authorization expired. Sign in again to reopen it.")
        session.deadline = performance.now() + Math.min(remaining, CONNECT_LEASE_MS)
      }
      if (url.pathname === "/api/preview-browser" && request.method === "POST") {
        const body = await request.json() as { targetId?: unknown; viewerId?: unknown; reload?: unknown }
        const entry = typeof body?.targetId === "string" ? options.target(body.targetId) : null
        if (!entry || entry.target.kind === "host-file" || (entry.target.kind === "project-file" && entry.target.markdown)) return Response.json({ error: "Preview target unavailable" }, { status: 404 })
        const viewer = typeof body.viewerId === "string" && /^[\w-]{1,128}$/u.test(body.viewerId) ? body.viewerId : undefined
        const session = await this.open(body.targetId as string, entry.target, options.owner, options.scope, entry.projectId, viewer, body.reload === true)
        try { renew(session) } catch (error) { await this.closeSession(session); throw error }
        return Response.json({ id: session.id }, { headers: { "Cache-Control": "no-store" } })
      }
      const match = /^\/api\/preview-browser\/([\w-]+)$/u.exec(url.pathname)
      const session = match ? this.sessions.get(match[1]!) : null
      if (!session || session.scope !== options.scope) return Response.json({ error: "Preview session expired. Retry to reopen the current page." }, { status: 410 })
      renew(session)
      session.touched = Date.now()
      const viewer = url.searchParams.get("viewer")
      if (request.method === "DELETE") {
        if (viewer) {
          session.viewers.delete(viewer)
          if (session.pointer?.viewer === viewer) await this.queuePointerRelease(session)
        } else await this.closeSession(session)
        return Response.json({ ok: true })
      }
      if (viewer) {
        if (!session.viewers.has(viewer)) return Response.json({ error: "Preview viewer expired. Retry to reopen the current page." }, { status: 410 })
        session.viewers.set(viewer, Date.now())
      }
      if (session.pointer?.viewer === viewer && url.searchParams.get("pointer") === String(session.pointer?.id)) session.pointer.seen = Date.now()
      if (request.method === "GET" && url.searchParams.get("ping") === "1") return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
      if (session.pending >= 8) return Response.json({ error: "Preview busy" }, { status: 429 })
      session.pending++
      const operation = session.tail.catch(() => undefined).then(async () => {
        // A queued press must not revive a viewer released while it was waiting.
        if (viewer && !session.viewers.has(viewer)) return Response.json({ error: "Preview viewer expired" }, { status: 410 })
        const width = Number(url.searchParams.get("width")), height = Number(url.searchParams.get("height"))
        const current = session.page.viewportSize()
        if (Number.isInteger(width) && width >= 320 && width <= 1600 && Number.isInteger(height) && height >= 200 && height <= 1200
          && (current?.width !== width || current?.height !== height)) await session.page.setViewportSize({ width, height })
        if (request.method === "POST") {
          const action = await request.json() as Record<string, unknown>
          const number = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
          if (action.type === "pointer") {
            if (!await this.pointerInput(session, viewer, action)) return Response.json({ error: "Invalid preview pointer input" }, { status: 400 })
            return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
          }
          else if (action.type === "click" && number(action.x, 1600) && number(action.y, 1200)) { await this.releasePointer(session); await session.page.mouse.click(action.x as number, action.y as number) }
          else if (action.type === "move" && number(action.x, 1600) && number(action.y, 1200)) { await session.page.mouse.move(action.x as number, action.y as number); return Response.json({ ok: true }) }
          else if (action.type === "resize" && number(action.width, 1600) && (action.width as number) >= 320 && number(action.height, 1200) && (action.height as number) >= 200) await session.page.setViewportSize({ width: Math.round(action.width as number), height: Math.round(action.height as number) })
          else if (action.type === "text" && typeof action.text === "string" && action.text.length <= 2000) await session.page.keyboard.insertText(action.text)
          else if (action.type === "key" && typeof action.key === "string" && /^(?:(?:Control|Meta|Alt|Shift)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/u.test(action.key)) {
            if (/(?:Control|Meta)\+.*[cvx]$/iu.test(action.key) || (action.key.includes("Shift+") && action.key.endsWith("Delete"))) return Response.json({ error: "Host clipboard shortcuts are unavailable in previews." }, { status: 400 })
            await session.page.keyboard.press(action.key)
          }
          else if (action.type === "scroll" && typeof action.dy === "number" && Number.isFinite(action.dy) && Math.abs(action.dy) <= 2000) {
            const dx = typeof action.dx === "number" && Number.isFinite(action.dx) ? Math.max(-2000, Math.min(2000, action.dx)) : 0
            await session.page.mouse.wheel(dx, action.dy)
          }
          else if (action.type === "reload") {
            // Retry is an explicit GET. Never replay a submitted POST form.
            const logical = new URL(this.address(session), "http://stillon.invalid")
            const destination = session.virtualOrigin && session.originalPrefix
              ? session.virtualOrigin + "/" + logical.pathname.slice(session.originalPrefix.length) + logical.search + logical.hash
              : logical.href
            session.error = undefined
            session.proxy?.reauthorize()
            await this.load(session, destination, true).catch(() => { session.error = "The page could not be loaded. Check the service and retry." })
          }
          else if (action.type === "navigate" && typeof action.address === "string") {
            const destination = new URL(action.address, session.page.url())
            if (session.virtualOrigin) {
              if (!session.originalPrefix || !action.address.startsWith(session.originalPrefix)) throw new Error("Outside preview folder")
              const relative = new URL(action.address, "http://stillon.invalid")
              destination.href = session.virtualOrigin + "/" + relative.pathname.slice(session.originalPrefix.length) + relative.search + relative.hash
            }
            if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) throw new Error("Invalid preview navigation")
            session.error = undefined
            session.lastAddress = action.address
            await this.load(session, destination.href).catch(() => { session.error = "The page could not be loaded. Check the service and retry." })
          } else return Response.json({ error: "Invalid preview input" }, { status: 400 })
          if (action.inputOnly === true && ["text", "key", "scroll"].includes(String(action.type))) return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
        } else if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } })
        const image = await this.capture(session)
        const result = { address: this.address(session), title: await this.title(session), image, ...session.page.viewportSize(), error: session.error, navigationType: session.navigationType }
        session.navigationType = undefined
        return Response.json(result, { headers: { "Cache-Control": "no-store" } })
      }).finally(() => { session.pending-- })
      session.tail = operation
      return await operation
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Preview browser unavailable",
      ...(error instanceof PreviewFramePendingError ? { retryableFrame: true } : {}) }, { status: 503, headers: { "Cache-Control": "no-store" } }) }
  }
}
