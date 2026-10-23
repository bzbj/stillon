import { clickDirectFileLink, verifyDirectFileInput } from "./verify-direct-file-input"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { chromium, firefox, type Page } from "playwright"
import { verifyPreviewInput } from "./verify-preview-input"

const filesOnly = process.argv.includes("--files-only")
const output = path.resolve("test-artifacts/workspace-previews", process.argv.includes("--firefox") ? "firefox" : "chromium")
await mkdir(output, { recursive: true })
const privateFixture = path.join(output, "private-browser-fixture-" + Date.now() + ".json")
const stopFile = path.join(output, "fixture.stop-" + Date.now())
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STILLON_UPDATE_") && !name.startsWith("STILLON_CONNECT_") && name !== "STILLON_RUNTIME_PROFILE"))
const child = spawn("bun", ["scripts/verify-workspace-previews.ts", ...process.argv.filter(value => ["--local-only", "--external-sites", "--files-only"].includes(value) || value.startsWith("--connect-fixture-module=")), "--browser-output=" + privateFixture, "--stop-file=" + stopFile], { env: environment, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" })
let fixtureExited = false
const fixtureExit = new Promise<void>(resolve => child.once("exit", () => { fixtureExited = true; resolve() }))
async function waitForFixtureExit(milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([fixtureExit.then(() => true), new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), milliseconds); timer.unref()
  })])
  if (timer) clearTimeout(timer)
  return exited
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const checks: { entry: string; check: string; result: string }[] = []
const networkFailures: { path: string; status: number; reason?: string }[] = []
const browserErrors: string[] = []
const assetFailures: Record<string, unknown>[] = []
const safeError = (value: string) => value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gu, raw => { try { return new URL(raw).pathname } catch { return "[URL]" } }).slice(0, 600)
async function acceptServicePreview(page: Page, verifyCancellation = false) {
  const warning = page.locator("[data-preview-service-warning]")
  await warning.waitFor()
  const creations: string[] = []
  const track = (request: import("playwright").Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/preview-browser") creations.push(request.url())
  }
  page.on("request", track)
  try {
    assert.equal(await page.getByAltText("Interactive browser preview").count(), 0)
    const lines = await warning.locator("h1 span").evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element)
      return { size: style.fontSize, weight: style.fontWeight }
    }))
    assert.equal(lines.length, 2); assert.deepEqual(lines[0], lines[1])
    if (verifyCancellation) {
      await page.getByRole("button", { name: "确认进入，继续预览本机服务网页" }).click()
      await page.getByRole("button", { name: "返回，使用本地 HTML", exact: true }).press("Enter")
      await page.getByRole("dialog").waitFor({ state: "hidden" })
      assert.equal(await warning.count(), 1)
      assert.equal(creations.length, 0, "Opening and cancelling the warning must not create a browser session")
    }
    await page.getByRole("button", { name: "确认进入，继续预览本机服务网页" }).click()
    assert.equal(creations.length, 0, "The confirmation dialog must not start a browser session")
    await page.getByRole("dialog").getByRole("button", { name: "确认进入", exact: true }).click()
    await warning.waitFor({ state: "hidden" })
  } finally { page.off("request", track) }
}
async function navigateServicePreview(page: Page, address: string, navigate: () => Promise<void>, applicationReady = false) {
  // An image from the previous address can still be visible when Enter returns.
  // Wait for the requested page's frame, not just the presence of an image.
  const frame = page.waitForResponse(async response => {
    if (response.request().method() !== "GET" || !/^\/api\/preview-browser\/[\w-]+$/u.test(new URL(response.url()).pathname) || !response.ok()) return false
    const value = await response.json().catch(() => null)
    return value?.address === address && typeof value.image === "string" && !value.error
      && (!applicationReady || /^Application \d+ true$/u.test(value.title ?? ""))
  })
  // Observe navigation failure and response timeout together; never replay input.
  await Promise.all([frame, (async () => {
    await navigate()
    // Same-service navigation keeps consent; a new service first shows its gate.
    // Do not leave a losing waitFor().then(click) alive for a later navigation.
    let settled = false
    void frame.then(() => { settled = true }, () => { settled = true })
    const deadline = Date.now() + 15_000
    while (!settled) {
      if (await page.locator("[data-preview-service-warning]").isVisible()) { await acceptServicePreview(page); break }
      assert(Date.now() < deadline, "The service preview neither showed its warning nor returned a frame")
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  })()])
}
let currentPage: Page | undefined
let stage = "startup"
const progress = setInterval(() => console.log("Browser validation stage: " + stage), 10_000)
progress.unref()
try {
  let config: any
  // Preparation runs the API, discovery and browser-lease regression matrix.
  // Native Windows runners can need more than two minutes for these checks.
  const fixtureDeadline = Date.now() + 5 * 60_000
  for (;;) {
    try { config = JSON.parse(await readFile(privateFixture, "utf8")); break } catch { /* Starting synthetic fixture. */ }
    assert(child.exitCode === null && child.signalCode === null, "Preview fixture exited before becoming ready")
    assert(Date.now() < fixtureDeadline, "Preview fixture preparation exceeded five minutes")
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const type = process.argv.includes("--firefox") ? firefox : chromium
  // Native tab gestures need the full browser, not Chromium's headless shell.
  browser = await type.launch({ ...(type === chromium ? { channel: process.platform === "win32" ? "msedge" : "chromium" } : {}), headless: true })
  for (const entry of config.entries) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(15_000)
    context.setDefaultNavigationTimeout(45_000)
    context.on("page", page => page.on("pageerror", error => browserErrors.push(safeError(error.message))))
    const assetResponses = new Map<import("playwright").Request, Record<string, unknown>>()
    context.on("response", response => {
      const pathname = new URL(response.url()).pathname
      if (!pathname.startsWith("/assets/")) return
      const headers = response.headers()
      assetResponses.set(response.request(), { path: pathname, status: response.status(), type: headers["content-type"],
        length: headers["content-length"], encoding: headers["content-encoding"], transfer: headers["transfer-encoding"],
        redirect: headers.location ? new URL(headers.location, response.url()).pathname : undefined })
      if (assetResponses.size > 200) assetResponses.delete(assetResponses.keys().next().value!)
    })
    context.on("requestfailed", request => {
      const pathname = new URL(request.url()).pathname
      browserErrors.push("Request " + pathname + ": " + request.failure()?.errorText)
      if (pathname.startsWith("/assets/")) assetFailures.push(assetResponses.get(request) ?? { path: pathname, response: "Unavailable" })
    })
    if (entry.cookie) await context.addCookies(entry.cookie.split("; ").map((part: string) => {
      const index = part.indexOf("="); return { name: part.slice(0, index), value: part.slice(index + 1), url: entry.origin }
    }))
    await context.addCookies([{ name: "stillon_fixture_secret", value: "fixture-secret", url: entry.origin }])
    let browserRequests = 0, browserCreations = 0, externalRegistrations = 0, imageHeadRequests = 0
    const requestTimes: number[] = []
    context.on("request", request => {
      if (new URL(request.url()).origin === entry.origin) requestTimes.push(Date.now())
      const path = new URL(request.url()).pathname
      if (path.startsWith("/api/preview-browser")) browserRequests++
      if (path === "/api/preview-browser" && request.method() === "POST") browserCreations++
      if (request.method() === "HEAD" && /^\/api\/preview-targets\/[\w-]+\/content$/u.test(path)) imageHeadRequests++
      if (path === "/api/preview-targets" && request.method() === "POST" && /^https?:\/\/example\.com\//u.test(request.postDataJSON()?.address ?? "")) externalRegistrations++
    })
    context.on("response", response => {
      if (response.status() !== 429 && response.status() < 500) return
      const failure = { path: new URL(response.url()).pathname, status: response.status(), reason: undefined as string | undefined }
      networkFailures.push(failure)
      void response.text().then(body => {
        try { const value = JSON.parse(body); if (typeof value.error === "string" && /^[A-Z_]+$/u.test(value.error)) failure.reason = value.error } catch { /* A native error document. */ }
        if (!failure.reason) failure.reason = body.includes("Computer offline") ? "COMPUTER_OFFLINE"
          : body === "Connection unavailable" ? "ADAPTER_CONNECTION_UNAVAILABLE" : body === "Connection limit" ? "ADAPTER_CONNECTION_LIMIT" : "UNCLASSIFIED_ERROR_RESPONSE"
      }).catch(() => { failure.reason = "ERROR_BODY_UNAVAILABLE" })
    })
    const paceConnect = async () => {
      if (!entry.gateway) return
      const waitingSince = Date.now(), previousStage = stage
      while (true) {
        const now = Date.now()
        while (requestTimes.length && requestTimes[0]! < now - 60_000) requestTimes.shift()
        if (requestTimes.length < 700) { stage = previousStage; return }
        stage = entry.name + ":traffic-budget"
        assert(now - waitingSince < 90_000, "Background workspace traffic prevented safe progress within a full gateway budget window")
        // The real gateway serves authenticated data without cache and limits
        // traffic to 1,200/minute. Leave room for bootstrap within one cell;
        // do not relax production authorization or abuse limits for this test.
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    const page = await context.newPage()
    currentPage = page
    const resolvedFileMenuLabels = async () => {
      // File menus render a loading state before their read-only metadata is ready.
      await page.getByRole("menuitem", { name: /^(Preview in sidebar|Open on this computer|Download)$/u }).first().waitFor()
      return page.getByRole("menuitem").allTextContents()
    }
    const images = async (current: Page) => { await current.getByAltText("Fixture image").waitFor(); await current.waitForFunction(() => [...document.images].some(image => image.alt === "Fixture image" && image.naturalWidth > 0)) }
    for (const name of ["project-markdown", "outside-markdown"]) {
      stage = entry.name + ":" + name + ":document-navigation"
      const url = entry.origin + "/preview/" + config.targetIds[entry.name][name]
      await page.goto(url, { waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { name: "Preview guide" }).waitFor()
      await images(page)
      assert.equal(await page.getByRole("table").count(), 1)
      const next = page.getByRole("link", { name: "Next document" })
      await next.click()
      await page.getByRole("heading", { name: "Next section" }).waitFor()
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { name: "Next section" }).waitFor()
      await page.goBack({ waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { name: "Preview guide" }).waitFor()
      await page.getByRole("link", { name: "Section", exact: true }).click()
      await page.getByRole("heading", { name: "Details" }).waitFor()
      checks.push({ entry: entry.name, check: name + " standalone rendering, relative image, links, reload, back, fragment", result: "Pass" })
    }
    await paceConnect()
    stage = entry.name + ":static-module-integrity"
    const imported = await page.evaluate(async ({ asset, metadata }) => {
      for (let index = 0; index < 20; index++) {
        const controller = new AbortController()
        const request = fetch(metadata, { signal: controller.signal, cache: "no-store" }).catch(() => undefined)
        const cancel = setTimeout(() => controller.abort(), 1)
        let timeout: number | undefined
        try {
          await Promise.race([import(asset + "?preview-integrity=" + Date.now() + "-" + index), new Promise<never>((_, reject) => {
            timeout = window.setTimeout(() => reject(new Error("A native static-module import timed out")), 10_000)
          })])
        } finally { clearTimeout(cancel); if (timeout) clearTimeout(timeout); controller.abort(); await request }
      }
      return 20
    }, { asset: config.moduleProbeAsset, metadata: "/api/preview-targets/" + config.targetIds[entry.name]["project-markdown"] })
    assert.equal(imported, 20)
    checks.push({ entry: entry.name, check: "Twenty native cache-busted module imports remain valid across cancelled metadata requests", result: "Pass" })
    stage = entry.name + ":chat:link-resolution"
    let idleFilePreparation = 0
    const trackIdlePreparation = (request: import("playwright").Request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === "/api/link-capabilities" || request.method() === "POST" && (/^\/api\/preview-targets(?:\/resolve)?$/u.test(pathname) || /^\/api\/file-previews\/[^/]+\/entry$/u.test(pathname))) idleFilePreparation++
    }
    context.on("request", trackIdlePreparation)
    await page.goto(entry.origin + "/chat/" + config.chatId, { waitUntil: "domcontentloaded" })
    const guide = page.getByRole("link", { name: "Read guide", exact: true })
    await guide.waitFor()
    await page.locator("textarea:not([disabled])").waitFor()
    assert.equal(idleFilePreparation, 0, "Reading a conversation must not prepare file links or capabilities")
    context.off("request", trackIdlePreparation)
    await page.evaluate(() => localStorage.setItem("stillon-main-secret", "fixture-secret"))
    await guide.click()
    await page.getByRole("heading", { name: "Preview guide" }).waitFor()
    assert.equal(new URL(page.url()).pathname, "/chat/" + config.chatId)
    const destination = new URL(await guide.getAttribute("href") ?? "", entry.origin)
    assert.equal(destination.origin, entry.origin)
    assert.equal(destination.pathname, "/resolve-resource")
    assert(decodeURIComponent(destination.searchParams.get("address") ?? "").endsWith("README.md"))
    for (const options of [{ modifiers: [process.platform === "darwin" ? "Meta" as const : "Control" as const] }, { button: "middle" as const }]) {
      stage = entry.name + ":chat:" + ("button" in options ? "middle-click" : "modified-click")
      const [popup] = await Promise.all([context.waitForEvent("page"), guide.click(options)])
      await popup.getByRole("heading", { name: "Preview guide" }).waitFor(); await popup.close(); await page.bringToFront()
    }
    await guide.click({ button: "right" })
    const labels = await resolvedFileMenuLabels()
    assert.deepEqual(labels, entry.name === "loopback" ? ["Preview in sidebar", "Open on this computer", "Show in folder"] : ["Preview in sidebar", "Download"])
    await page.getByRole("menuitem", { name: "Preview in sidebar", exact: true }).focus()
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    await guide.focus(); await page.keyboard.press("Shift+F10")
    assert.equal(await page.getByRole("menu").count(), 1)
    await resolvedFileMenuLabels()
    await page.getByRole("menuitem", { name: "Preview in sidebar", exact: true }).focus()
    await page.keyboard.press("Enter")
    await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
    checks.push({ entry: entry.name, check: "Chat link sidebar routing, modifier/middle-click independent reading, stable custom file menu", result: "Pass" })
    const menuLabels = (previewable: boolean) => entry.name === "loopback"
      ? [...(previewable ? ["Preview in sidebar"] : []), "Open on this computer", "Show in folder"]
      : [...(previewable ? ["Preview in sidebar"] : []), "Download"]
    const verifyDownload = async (activate: () => Promise<unknown>, fileName: string) => {
      const pending = page.waitForEvent("download")
      await activate()
      const download = await pending, stream = await download.createReadStream()
      assert.equal(download.suggestedFilename(), fileName); assert(stream)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      assert.equal(await download.failure(), null)
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
      assert.equal(hash(Buffer.concat(chunks)), hash(await readFile(path.join(config.projectPath, fileName))))
    }
    for (const [label, fileName, previewable] of [["Text sample", "中文 text.txt", true], ["Image sample", "中文 image.png", true], ["Office sample", "sample.docx", false]] as const) {
      const link = page.getByRole("link", { name: label, exact: true })
      await link.click({ button: "right" })
      assert.deepEqual(await resolvedFileMenuLabels(), menuLabels(previewable))
      if (entry.name !== "loopback") await verifyDownload(() => page.getByRole("menuitem", { name: "Download", exact: true }).click(), fileName)
      else await page.keyboard.press("Escape")
      if (previewable) {
        await link.click()
        if (label === "Image sample") await page.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
        else await page.getByText("中文 text <script>", { exact: false }).waitFor()
        await page.getByRole("button", { name: "Back", exact: true }).click()
        await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
      } else if (entry.name !== "loopback") await verifyDownload(() => link.click(), fileName)
    }
    const markdownImage = page.getByRole("link", { name: "Image", exact: true })
    await markdownImage.click({ button: "right" })
    assert.deepEqual(await resolvedFileMenuLabels(), menuLabels(true))
    await page.getByRole("menuitem", { name: "Preview in sidebar", exact: true }).click()
    await page.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
    const markdownOffice = page.getByRole("link", { name: "Office", exact: true })
    await markdownOffice.click({ button: "right" })
    assert.deepEqual(await resolvedFileMenuLabels(), menuLabels(false))
    if (entry.name !== "loopback") {
      await verifyDownload(() => page.getByRole("menuitem", { name: "Download", exact: true }).click(), "sample.docx")
      await verifyDownload(() => markdownOffice.click(), "sample.docx")
    } else await page.keyboard.press("Escape")
    checks.push({ entry: entry.name, check: "Chat/Markdown text, image and Office menu policies; native image sidebar; remote menu/default downloads preserve original bytes", result: "Pass" })
    stage = entry.name + ":external-links"
    const externalPattern = /^https?:\/\/example\.com\/report\.(?:html|md)$/u
    await context.route(externalPattern, route => route.fulfill({ status: 200, contentType: "text/html", headers: { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" }, body: '<h1>Controlled external website</h1>' }))
    for (const label of ["External website", "External HTTP", "External"]) {
      const link = page.getByRole("link", { name: label, exact: true })
      const destination = await link.getAttribute("href"), before = browserRequests
      assert.equal(await link.evaluate(element => { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented }), false)
      const opened = context.waitForEvent("page")
      await link.click()
      const external = await opened
      await external.getByRole("heading", { name: "Controlled external website" }).waitFor()
      assert.equal(external.url(), destination)
      assert.equal(browserRequests, before)
      assert.equal(externalRegistrations, 0)
      await external.close(); await page.bringToFront()
      await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
    }
    checks.push({ entry: entry.name, check: "Chat/Markdown external HTTP(S) .html/.md links open original visiting-device tabs with native menus and no browser sessions", result: "Pass" })
    // Routing disables the context's HTTP cache. Restore normal caching before
    // many standalone reloads so the fixture models visiting-browser traffic.
    await context.unroute(externalPattern)
    stage = entry.name + ":markdown-body-links"
    for (const label of filesOnly ? ["HTML application"] : ["HTML application", "Host HTTP application"]) {
      await page.getByRole("link", { name: label, exact: true }).click()
      if (label === "HTML application") await page.frameLocator('iframe[title="HTML file preview"]').getByText("ES module ready").waitFor()
      else await page.getByAltText("Interactive browser preview").waitFor()
      await page.getByRole("button", { name: "Back", exact: true }).click()
      await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
    }
    checks.push({ entry: entry.name, check: "Markdown body HTML and host HTTP links route through the shared sidebar", result: "Pass" })
    stage = entry.name + ":workspace-without-git"
    await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b")
    assert.equal(await page.getByRole("button", { name: "Changes", exact: true }).count(), 0)
    await page.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
    checks.push({ entry: entry.name, check: "Retired Git shortcut leaves the document preview open without a Changes panel", result: "Pass" })
    const browserButton = page.getByRole("button", { name: "Browser", exact: true })
    if (await browserButton.getAttribute("aria-pressed") !== "true") await browserButton.click()
    const address = page.getByPlaceholder("Enter a URL")
    await address.waitFor()
    if (!filesOnly) {
    stage = entry.name + ":service-list"
    await page.getByRole("button", { name: "Home", exact: true }).click()
    const service = page.getByRole("button").filter({ has: page.getByText("http://localhost:" + config.serviceListPort, { exact: true }) }).filter({ hasText: "Service restored" })
    const creationsBeforeWarning = browserCreations
    await service.click()
    await page.locator("[data-preview-service-warning]").waitFor()
    assert.equal(browserCreations, creationsBeforeWarning, "Opening a service must show its warning before creating a browser")
    await acceptServicePreview(page, true)
    await page.getByAltText("Interactive browser preview").waitFor()
    assert.equal(new URL(await address.inputValue()).port, String(config.serviceListPort))
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await service.getByRole("button", { name: "Server actions", exact: true }).click()
    const servicePopup = context.waitForEvent("page")
    await page.getByRole("menuitem", { name: "Open in New Tab", exact: true }).click()
    const independentService = await servicePopup
    await acceptServicePreview(independentService)
    await independentService.getByAltText("Interactive browser preview").waitFor()
    assert.equal(new URL(await independentService.getByLabel("Preview address").textContent() ?? "").port, String(config.serviceListPort))
    await independentService.close(); await page.bringToFront()
    checks.push({ entry: entry.name, check: "Service-list sidebar and standalone require explicit consent; cancellation starts no browser session; static warning has equal-weight title lines", result: "Pass" })
    }
    for (const name of Object.keys(config.addresses[entry.name]).filter(name => !filesOnly || name !== "dynamic")) {
      await paceConnect()
      stage = entry.name + ":" + name + ":sidebar"
      const destination = config.addresses[entry.name][name]
      const navigate = async () => { await address.fill(destination); await address.press("Enter") }
      if (name === "dynamic") await navigateServicePreview(page, destination, navigate, true)
      else await navigate()
      await page.waitForFunction(value => (document.querySelector('input[placeholder="Enter a URL"]') as HTMLInputElement)?.value === value, config.addresses[entry.name][name])
      if (name.endsWith("markdown")) { await page.getByRole("heading", { name: "Preview guide" }).waitFor(); await images(page) }
      else if (name.endsWith("html")) {
        await verifyDirectFileInput(page, type === chromium)
        if (name === "project-html") {
          const input = page.frameLocator('iframe[title="HTML file preview"]').getByRole("textbox", { name: "File input" })
          await input.fill("Native state survives zoom and resize")
          await page.getByRole("button", { name: "Zoom out", exact: true }).click()
          await page.waitForFunction(() => (document.querySelector('iframe[title="HTML file preview"]') as HTMLElement)?.style.transform === "scale(0.9)")
          await page.getByRole("button", { name: "Zoom out", exact: true }).click()
          await page.waitForFunction(() => (document.querySelector('iframe[title="HTML file preview"]') as HTMLElement)?.style.transform === "scale(0.8)")
          await page.setViewportSize({ width: 1280, height: 900 })
          assert.equal(await input.inputValue(), "Native state survives zoom and resize")
          await verifyDirectFileInput(page, type === chromium)
          await page.setViewportSize({ width: 1440, height: 1000 })
          await page.getByRole("button", { name: "Zoom in", exact: true }).click()
          await page.waitForFunction(() => (document.querySelector('iframe[title="HTML file preview"]') as HTMLElement)?.style.transform === "scale(0.9)")
          await page.getByRole("button", { name: "Zoom in", exact: true }).click()
          await page.waitForFunction(() => (document.querySelector('iframe[title="HTML file preview"]') as HTMLElement)?.style.transform === "scale(1)")
          assert.equal(await input.inputValue(), "你日本語🙂")
          checks.push({ entry: entry.name, check: "Native HTML retains state across 80% zoom and resize; IME and 150 CSS px drag remain correct", result: "Pass" })
          const next = page.frameLocator('iframe[title="HTML file preview"]').getByRole("link", { name: "Next page", exact: true })
          for (const options of [{ modifiers: [process.platform === "darwin" ? "Meta" as const : "Control" as const] }, { button: "middle" as const }]) {
            stage = entry.name + ":project-html:nested-open:" + ("button" in options ? "middle" : "modified")
            const opened = context.waitForEvent("page")
            await clickDirectFileLink(page, next, options)
            const independent = await opened
            currentPage = independent
            stage = entry.name + ":project-html:nested-standalone:" + ("button" in options ? "middle" : "modified")
            await independent.frameLocator('iframe[title="HTML file preview"]').getByRole("heading", { name: "Next page", exact: true }).waitFor()
            await independent.frameLocator('iframe[title="HTML file preview"]').getByText("Nested resources ready", { exact: true }).waitFor()
            await independent.reload({ waitUntil: "domcontentloaded" })
            await independent.frameLocator('iframe[title="HTML file preview"]').getByText("Nested resources ready", { exact: true }).waitFor()
            assert.match(independent.url(), /\/preview\/[\w-]+$/u)
            assert((await independent.getByLabel("Preview address").textContent())?.endsWith("next.html?tab=one#section"))
            await independent.close(); currentPage = page; await page.bringToFront()
          }
          await clickDirectFileLink(page, next)
          await page.frameLocator('iframe[title="HTML file preview"]').getByRole("heading", { name: "Next page", exact: true }).waitFor()
          await page.frameLocator('iframe[title="HTML file preview"]').getByText("Nested resources ready", { exact: true }).waitFor()
          assert((await address.inputValue()).endsWith("next.html?tab=one#section"))
          await page.getByRole("button", { name: "Back", exact: true }).click()
          await page.frameLocator('iframe[title="HTML file preview"]').getByText("ES module ready", { exact: true }).waitFor()
          checks.push({ entry: entry.name, check: "HTML ordinary/modifier/middle document navigation preserves logical independent URLs and history", result: "Pass" })
        }
      } else if (name.endsWith("text")) {
        await page.getByText('中文 text <script>throw new Error("must not execute")</script>', { exact: false }).waitFor()
      } else if (name.endsWith("image")) {
        await page.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
      } else {
        const preview = page.getByAltText("Interactive browser preview")
        await preview.waitFor()
        await page.waitForFunction(() => { const image = document.querySelector('img[alt="Interactive browser preview"]') as HTMLImageElement; return image?.naturalWidth === Math.round(image.getBoundingClientRect().width) })
        if (name === "dynamic") {
          const before = (await (await fetch(config.appOrigin + "/api/counter")).json()).count
          await preview.click({ position: { x: 60, y: 120 } })
          for (let attempt = 0; ; attempt++) {
            const after = (await (await fetch(config.appOrigin + "/api/counter")).json()).count
            if (after === before + 1) break
            assert(attempt < 50, "The actual sidebar button must write through the application API")
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          await preview.click({ position: { x: 60, y: 180 } })
          await page.waitForFunction(() => (document.querySelector('input[placeholder="Enter a URL"]') as HTMLInputElement)?.value.endsWith("/nested?tab=one#section"))
        }
      }
      const currentAddress = await address.inputValue()
      const popupPromise = context.waitForEvent("page")
      await page.getByRole("button", { name: "Open standalone", exact: true }).click()
      const popup = await popupPromise
      currentPage = popup
      stage = entry.name + ":" + name + ":standalone"
      await popup.waitForURL(/\/preview\/[\w-]+$/u, { waitUntil: "domcontentloaded" })
      if (name.endsWith("markdown")) await popup.getByRole("heading", { name: "Preview guide" }).waitFor()
      else if (name.endsWith("html")) await verifyDirectFileInput(popup, type === chromium)
      else if (name.endsWith("text")) await popup.getByText('中文 text <script>', { exact: false }).waitFor()
      else if (name.endsWith("image")) await popup.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
      else { await acceptServicePreview(popup); await popup.getByAltText("Interactive browser preview").waitFor() }
      assert.equal(await popup.getByLabel("Preview address").textContent(), currentAddress)
      await popup.reload({ waitUntil: "domcontentloaded" })
      stage = entry.name + ":" + name + ":standalone-reload"
      if (name.endsWith("markdown")) await popup.getByRole("heading", { name: "Preview guide" }).waitFor()
      else if (name.endsWith("html")) await verifyDirectFileInput(popup, type === chromium)
      else if (name.endsWith("text")) await popup.getByText('中文 text <script>', { exact: false }).waitFor()
      else if (name.endsWith("image")) await popup.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
      else { await acceptServicePreview(popup); await popup.getByAltText("Interactive browser preview").waitFor() }
      if (name === "project-markdown") await popup.screenshot({ path: path.join(output, entry.name + "-markdown-standalone.png") })
      if (name !== "dynamic") {
        stage = entry.name + ":" + name + ":deleted-file-retry"
        const directory = name.startsWith("outside") ? config.outsidePath : config.projectPath
        const root = path.resolve(config.fixtureRoot), relative = path.relative(root, path.resolve(directory))
        assert(path.basename(root).startsWith("stillon-workspace-previews-") && ["workspace", "outside"].includes(relative))
        const fileName = name.endsWith("markdown") ? "README.md" : name.endsWith("html") ? "index.html" : name.endsWith("text") ? "中文 text.txt" : "中文 image.png"
        const source = path.join(directory, fileName), held = source + ".qa-hold-" + Date.now()
        assert((await stat(source)).isFile()); assert.equal(await stat(held).then(() => true, () => false), false)
        await rename(source, held)
        try {
          for (const view of [page, popup]) {
            currentPage = view
            // A prepared HTML target revalidates directly at file entry rather
            // than registering the same address again before every refresh.
            const missing = view.waitForResponse(response => response.status() === 404 && /^\/api\/(?:preview-targets(?:\/|$)|file-previews\/[\w-]+\/entry$)/u.test(new URL(response.url()).pathname))
            await view.getByRole("button", { name: "Refresh", exact: true }).click()
            await missing
            await view.getByRole("alert").filter({ hasText: /not found|404/iu }).first().waitFor()
          }
        } finally {
          assert.equal(await stat(source).then(() => true, () => false), false)
          await rename(held, source)
        }
        for (const view of [page, popup]) {
          await view.getByRole("button", { name: "Refresh", exact: true }).click()
          if (name.endsWith("markdown")) await view.getByRole("heading", { name: "Preview guide", exact: true }).waitFor()
          else if (name.endsWith("html")) await view.frameLocator('iframe[title="HTML file preview"]').getByText("ES module ready", { exact: true }).waitFor()
          else if (name.endsWith("text")) await view.getByText('中文 text <script>', { exact: false }).waitFor()
          else await view.waitForFunction(() => [...document.images].some(image => image.alt.includes("中文 image.png") && image.naturalWidth > 0))
        }
      }
      await popup.close()
      currentPage = page
      await page.bringToFront()
      if (name === "dynamic") await page.waitForFunction(() => { const image = document.querySelector('img[alt="Interactive browser preview"]') as HTMLImageElement; return image?.naturalWidth === Math.round(image.getBoundingClientRect().width) })
      checks.push({ entry: entry.name, check: name + " sidebar, independent window, refresh, deleted-file error and recovery", result: "Pass" })
      if (name === "project-markdown" || name === "dynamic") await page.screenshot({ path: path.join(output, entry.name + "-" + name + "-sidebar.png") })
    }
    stage = entry.name + ":image-formats"
    for (const outside of [false, true]) for (const extension of ["png", "jpg", "webp", "gif", "svg", "avif", "apng", "bmp", "ico"]) {
      await paceConnect()
      stage = entry.name + ":image:" + (outside ? "host:" : "project:") + extension
      const headsBefore = imageHeadRequests
      const fileName = "图 image." + extension
      const base = outside ? config.addresses[entry.name]["outside-image"].replace(/[^/]+$/u, encodeURIComponent(config.outsidePath + "/" + fileName))
        : `/api/projects/${config.projectId}/preview/${encodeURIComponent(fileName)}`
      await address.fill(base); await address.press("Enter")
      await page.waitForFunction((name) => [...document.images].some(image => image.alt.endsWith(name) && image.naturalWidth > 0), fileName)
      const image = page.locator('img[alt*="图 image."]')
      assert(await image.evaluate(image => (image as HTMLImageElement).naturalWidth / (image as HTMLImageElement).naturalHeight > 0))
      if (["gif", "apng"].includes(extension)) {
        // Canvas image import can select the default frame. Observe the actual
        // displayed pixels instead, without rewriting or decoding the image.
        const frames = new Set<string>()
        for (let attempt = 0; attempt < 12 && frames.size < 2; attempt++) {
          frames.add((await image.screenshot({ animations: "allow" })).toString("base64"))
          await page.waitForTimeout(40 + attempt * 7)
        }
        assert(frames.size > 1, "The native animated image must keep changing frames")
      }
      if (extension === "svg") assert.equal(await page.evaluate(() => (window as Window & { svgExecuted?: boolean }).svgExecuted), undefined)
      const popupPromise = context.waitForEvent("page")
      await page.getByRole("button", { name: "Open standalone", exact: true }).click()
      const popup = await popupPromise
      await popup.waitForFunction((name) => [...document.images].some(image => image.alt.endsWith(name) && image.naturalWidth > 0), fileName)
      await popup.reload({ waitUntil: "domcontentloaded" })
      await popup.waitForFunction((name) => [...document.images].some(image => image.alt.endsWith(name) && image.naturalWidth > 0), fileName)
      assert.equal(imageHeadRequests, headsBefore, "Successful native images must load directly without HEAD probes")
      await popup.close(); await page.bringToFront()
      checks.push({ entry: entry.name, check: (outside ? "Authorized host" : "Project") + " " + extension + " native image sidebar/standalone/reload", result: "Pass" })
    }
    for (const [fileName, message] of [["broken.png", "Image cannot be read"], ["oversized.png", "25 MB"], ["large-dimensions.svg", "40 megapixel"]]) {
      await address.fill(`/api/projects/${config.projectId}/preview/${fileName}`); await address.press("Enter")
      await page.getByRole("alert").filter({ hasText: message }).waitFor()
      assert.equal(await page.getByRole("button", { name: "Retry image" }).count(), 1)
    }
    checks.push({ entry: entry.name, check: "Damaged/oversized images report failures and offer retry", result: "Pass" })
    await address.fill(`/api/projects/${config.projectId}/preview/long.png`); await address.press("Enter")
    const longImage = page.locator('img[alt="long.png"]')
    await longImage.waitFor()
    await page.getByRole("button", { name: "Zoom in", exact: true }).click()
    assert(await longImage.evaluate(image => {
      let element: HTMLElement | null = image as HTMLElement
      while (element && element.scrollHeight <= element.clientHeight) element = element.parentElement
      if (!element) return false
      element.scrollTop = 1000
      return element.scrollTop > 0
    }))
    await page.getByRole("button", { name: "Zoom out", exact: true }).click()
    checks.push({ entry: entry.name, check: "Long image preserves aspect, zoom and scrolling", result: "Pass" })
    if (filesOnly) assert.equal(browserRequests, 0, "Files must not start browser sessions or screenshot polling")
    for (const view of filesOnly ? [] : ["direct", "sidebar", "standalone"] as const) {
      const inputPage = view === "sidebar" ? page : await context.newPage()
      currentPage = inputPage
      const evidence = await verifyPreviewInput({ page: inputPage, appOrigin: config.appOrigin,
        name: entry.name + "-" + view, direct: view === "direct", chromium: type === chromium,
        stage: value => { stage = value }, screenshot: path.join(output, entry.name + "-" + type.name() + "-input-" + view + ".png"),
        prepare: async destination => {
          if (view === "direct") await inputPage.goto(destination, { waitUntil: "domcontentloaded" })
          else if (view === "sidebar") {
            await navigateServicePreview(inputPage, destination, async () => { await address.fill(destination); await address.press("Enter") })
            await inputPage.getByAltText("Interactive browser preview").waitFor()
          }
          else {
            const response = await inputPage.request.post(entry.origin + "/api/preview-targets", { headers: { Origin: entry.origin }, data: { projectId: config.projectId, address: destination } })
            assert(response.ok()); const target = await response.json()
            await inputPage.goto(entry.origin + target.url, { waitUntil: "domcontentloaded" })
            await acceptServicePreview(inputPage)
          }
        } })
      checks.push({ entry: entry.name, check: view + " English, Chinese/Japanese " + (evidence.nativeIme ? "native IME" : "synthetic composition lifecycle")
        + ", emoji, long paste, scaled mouse drag, capture release" + (evidence.nativeTouch ? ", native touch drag/cancel" : "") + "; " + evidence.paste, result: "Pass" })
      if (inputPage !== page) await inputPage.close()
    }
    await context.close()
  }
  const report = JSON.stringify({ browser: browser.version(), secondDevice: false, filesOnly, hostOS: process.platform, commit: config.sourceVersion, dirty: config.dirty, clientBuild: config.clientVersion, serverBuild: config.sourceVersion, adapterBuild: config.adapterVersion, gatewayBuild: config.gatewayVersion, checks }, null, 2)
  await writeFile(path.join(output, (filesOnly ? "browser-results-files-only.json" : "browser-results.json")), report)
  await writeFile(path.join(output, "browser-results-" + type.name() + (filesOnly ? "-files-only" : "") + ".json"), report)
  console.log(JSON.stringify({ browser: browser.version(), secondDevice: false, checks }, null, 2))
} catch (error) {
  console.error("Browser validation failed at " + stage)
  console.error("Recent network failures:", networkFailures.slice(-20))
  console.error("Recent browser errors:", browserErrors.slice(-20))
  console.error("Failed asset response metadata:", assetFailures.slice(-10))
  if (currentPage && !currentPage.isClosed()) {
    console.error("Parent page text:", safeError(await currentPage.locator("body").innerText()).slice(0, 600))
    console.error("Preview status:", await currentPage.getByRole("status").allTextContents())
    console.error("Preview alerts:", await currentPage.getByRole("alert").allTextContents())
    console.error("Validation path:", new URL(currentPage.url()).pathname, "frames:", currentPage.frames().map(frame => { try { return new URL(frame.url()).pathname } catch { return frame.url() } }))
    await currentPage.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined)
    await writeFile(path.join(output, "failure.txt"), await currentPage.locator("body").innerText()).catch(() => undefined)
  }
  throw error
} finally {
  clearInterval(progress)
  await browser?.close()
  await writeFile(stopFile, "stop")
  if (!await waitForFixtureExit(15_000) && !fixtureExited && child.pid) {
    console.warn("Preview fixture cleanup exceeded its deadline; terminating only its owned process tree.")
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      await new Promise<void>((resolve, reject) => { killer.once("exit", () => resolve()); killer.once("error", reject) })
    } else {
      try { process.kill(-child.pid, "SIGKILL") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    assert(await waitForFixtureExit(5_000), "The owned preview fixture could not be stopped")
  }
}
