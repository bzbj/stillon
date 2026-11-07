import assert from "node:assert/strict"
import type { Locator, Page } from "playwright"

export async function verifyHtmlPreviewRecovery(page: Page) {
  const iframe = page.locator('iframe[title="HTML file preview"]')
  await iframe.locator("..").and(page.locator('[aria-busy="false"]')).waitFor()
  const url = (await iframe.getAttribute("src"))!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const hold = async (route: import("playwright").Route) => { await gate; await route.continue() }
  await page.route(url, hold)
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "Loading file preview…" }).waitFor()
    // A message from the parent window is not a readiness receipt from the iframe.
    await page.evaluate(() => window.postMessage({ type: "stillon:file-ready" }, "*"))
    await page.getByRole("alert").filter({ hasText: "This file preview is taking longer than expected." }).waitFor({ timeout: 25_000 })
    release()
    await page.frameLocator('iframe[title="HTML file preview"]').getByText("ES module ready", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Retry preview", exact: true }).waitFor({ state: "hidden" })
  } finally { release(); await page.unroute(url, hold) }
  // Error documents also fire iframe load. Only a document readiness receipt counts.
  // Canceled navigations can consume a one-shot route before committing a page.
  // Keep the resource unavailable until the explicit recovery action below.
  let unavailableRequests = 0
  const unavailable = async (route: import("playwright").Route) => {
    unavailableRequests++
    await route.fulfill({ status: 403, contentType: "text/html", body: "<h1>Fixture unavailable</h1>" })
  }
  await page.route(url, unavailable)
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.frameLocator('iframe[title="HTML file preview"]').getByText("Fixture unavailable", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Retry preview", exact: true }).waitFor({ timeout: 25_000 })
  } catch (error) {
    console.error("HTML recovery injection", { requests: unavailableRequests,
      sameSource: await iframe.evaluateAll((frames, source) => frames.some(frame => frame.getAttribute("src") === source), url).catch(() => false) })
    throw error
  } finally { await page.unroute(url, unavailable) }
  await page.getByRole("button", { name: "Retry preview", exact: true }).click()
  await page.frameLocator('iframe[title="HTML file preview"]').getByText("ES module ready", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Retry preview", exact: true }).waitFor({ state: "hidden" })
}

async function displayedFileBox(page: Page, element: Locator) {
  const frameElement = page.locator('iframe[title="HTML file preview"]')
  await page.bringToFront()
  const deadline = Date.now() + 5_000
  for (;;) {
    // The child can be ready before the parent removes its loading bar.
    // Wait for that layout change before measuring native mouse coordinates.
    await frameElement.locator("..").and(page.locator('[aria-busy="false"]')).waitFor()
    await element.scrollIntoViewIfNeeded()
    await (await frameElement.elementHandle())!.waitForElementState("stable")
    const outer = await frameElement.boundingBox()
    assert(outer)
    const size = await frameElement.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }))
    const inner = await element.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    const scale = outer.width / size.width, scaleY = outer.height / size.height
    // Locator coordinates across scaled frames can omit the frame's scale.
    // Native mouse input uses the actual visiting viewport, as a person does.
    const box = { x: outer.x + inner.x * scale, y: outer.y + inner.y * scaleY, width: inner.width * scale, height: inner.height * scaleY, scale }
    // Re-enter from outside the frame: repeatedly moving to the same point can
    // leave Chromium's hover target stale after iframe layout/tab changes.
    // CSS :hover can remain set in an obscured cross-origin frame. Observe a
    // trusted pointermove instead. Only motion is retried; click/drag runs once.
    await page.mouse.move(0, 0)
    let paintTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        frameElement.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))),
        new Promise<void>(resolve => { paintTimer = setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))) }),
      ])
    } finally { clearTimeout(paintTimer) }
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const probe = await element.evaluateHandle(element => {
      const result = { received: false, hit: false, target: "", cleanup: () => {} }
      const receive = (event: PointerEvent) => {
        if (!event.isTrusted || event.pointerType !== "mouse") return
        result.received = true
        result.hit = event.target instanceof Node && (event.target === element || element.contains(event.target))
        result.target = event.target instanceof Element ? event.target.tagName : ""
      }
      document.addEventListener("pointermove", receive, true)
      result.cleanup = () => document.removeEventListener("pointermove", receive, true)
      return result
    })
    let pointer: { received: boolean; hit: boolean; target: string }
    try {
      await page.mouse.move(point.x, point.y)
      pointer = await probe.evaluate(result => ({ received: result.received, hit: result.hit, target: result.target }))
    } finally {
      await probe.evaluate(result => result.cleanup()).catch(() => undefined)
      await probe.dispose()
    }
    const parentHit = await frameElement.evaluate((frame, point) => document.elementFromPoint(point.x, point.y) === frame, point)
    const childHit = await element.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hit === element || Boolean(hit && element.contains(hit))
    })
    if (parentHit && childHit && pointer.hit) return box
    if (Date.now() >= deadline) {
      const parent = await page.evaluate(point => ({ focused: document.hasFocus(), visibility: document.visibilityState,
        hit: document.elementFromPoint(point.x, point.y)?.tagName }), point)
      const child = await element.evaluate(element => {
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { focused: document.hasFocus(), hit: hit?.tagName, target: element.tagName,
          receivesPointer: hit === element || Boolean(hit && element.contains(hit)) }
      })
      assert.fail("Native pointer did not reach the HTML preview element: " + JSON.stringify({ box, point, outer, size, inner, parent, child, pointer, parentHit, childHit }))
    }
  }
}

export async function clickDirectFileLink(page: Page, element: Locator, options: { modifiers?: readonly ("Control" | "Meta")[]; button?: "middle" } = {}) {
  const box = await displayedFileBox(page, element)
  for (const key of options.modifiers ?? []) await page.keyboard.down(key)
  try { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: options.button ?? "left" }) }
  finally { for (const key of options.modifiers ?? []) await page.keyboard.up(key) }
}

export async function verifyDirectFileInput(page: Page, chromium: boolean) {
  const frame = page.frameLocator('iframe[title="HTML file preview"]')
  await frame.getByText("ES module ready", { exact: true }).waitFor()
  const resources = await frame.locator("body").evaluate(async () => {
    await document.fonts.ready
    return { mode: document.compatMode, classic: (window as Window & { classicReady?: boolean }).classicReady,
      font: [...document.fonts].some(font => font.family === "Fixture" && font.status === "loaded"),
      image: [...document.images].some(image => image.naturalWidth > 0), background: getComputedStyle(document.body).backgroundColor }
  })
  assert.equal(resources.mode, "CSS1Compat"); assert.equal(resources.classic, true); assert(resources.font); assert(resources.image)
  assert.equal(resources.background, "rgb(241, 248, 245)")
  const pixel = await frame.locator("#native-canvas").evaluate(element => [...(element as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data])
  assert.deepEqual(pixel, [40, 150, 180, 255])
  const button = frame.locator("#add")
  const before = Number((await button.textContent())?.split(": ").at(-1))
  await button.evaluate(() => {
    const state = window as Window & { fixturePointer?: { id: string; x: number; y: number } }
    delete state.fixturePointer
    document.addEventListener("pointerdown", event => {
      state.fixturePointer = { id: (event.target as HTMLElement).id, x: event.clientX, y: event.clientY }
    }, { once: true, capture: true, passive: true })
  })
  const buttonBox = await displayedFileBox(page, button)
  await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
  await page.waitForTimeout(50)
  const after = await button.textContent()
  if (after !== "Add one: " + (before + 1)) console.error("Native file input miss", {
    measured: buttonBox, currentFrame: await page.locator('iframe[title="HTML file preview"]').boundingBox(),
    currentButton: await button.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        pointer: (window as Window & { fixturePointer?: unknown }).fixturePointer ?? null }
    }),
  })
  assert.equal(after, "Add one: " + (before + 1))
  const input = frame.getByRole("textbox", { name: "File input" })
  await input.fill(""); await input.focus()
  if (chromium) {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("Input.imeSetComposition", { text: "n", selectionStart: 1, selectionEnd: 1 })
      await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 })
      await cdp.send("Input.insertText", { text: "你" })
    } finally { await cdp.detach() }
  } else await input.fill("你")
  assert.equal(await input.inputValue(), "你")
  await page.keyboard.insertText("日本語🙂")
  assert.equal(await input.inputValue(), "你日本語🙂")
  const drag = frame.locator("#native-drag"), box = await displayedFileBox(page, drag), scale = box.scale
  await page.mouse.move(box.x + 10 * scale, box.y + 10 * scale); await page.mouse.down()
  await page.mouse.move(box.x + 160 * scale, box.y + 10 * scale, { steps: 12 }); await page.mouse.up()
  assert.equal(Math.round(Number(await drag.getAttribute("data-x"))), 150)
  const denied = await input.evaluate(async (_input, parentOrigin) => {
    let parentDenied = false
    try { void parent.document.body } catch { parentDenied = true }
    let apiDenied = false
    try { await fetch(parentOrigin + '/api/sidebar-view', { credentials: 'include' }) } catch { apiDenied = true }
    return { parentDenied, apiDenied, cookie: document.cookie, storage: localStorage.getItem("stillon-main-secret") }
  }, new URL(page.url()).origin)
  assert(denied.parentDenied); assert(denied.apiDenied)
  assert(!denied.cookie.includes("fixture-secret")); assert.equal(denied.storage, null)
  const warning = page.getByRole("button", { name: "Dismiss dependency warning", exact: true })
  if (await warning.count()) await warning.click()
  let hostActions = 0
  const actionRoute = /\/api\/preview-targets\/[\w-]+\/action$/u
  const blockAction = async (route: import("playwright").Route) => { hostActions++; await route.fulfill({ json: { ok: true } }) }
  await page.route(actionRoute, blockAction)
  try {
    const before = page.url()
    await input.evaluate(() => {
      parent.postMessage({ type: "stillon:file-navigation", path: "/index.html", query: "/../../private.md", fragment: "" }, "*")
      parent.postMessage({ type: "stillon:file-link", path: "/sample.docx", query: "", fragment: "" }, "*")
    })
    await page.waitForTimeout(100)
    assert.equal(hostActions, 0, "Untrusted document messages cannot launch host applications")
    assert.equal(page.url(), before)
    await frame.getByText("ES module ready", { exact: true }).waitFor()
    const dismiss = page.getByRole("button", { name: "Dismiss", exact: true })
    if (await dismiss.count()) await dismiss.click()
  } finally { await page.unroute(actionRoute, blockAction) }
  return { nativeIme: chromium, text: "你日本語🙂", drag: 150, isolated: true }
}
