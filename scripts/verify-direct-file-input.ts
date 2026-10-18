import assert from "node:assert/strict"
import type { Locator, Page } from "playwright"

export async function verifyDirectFileInput(page: Page, chromium: boolean) {
  const frame = page.frameLocator('iframe[title="HTML file preview"]')
  const frameElement = page.locator('iframe[title="HTML file preview"]')
  const displayedBox = async (element: Locator) => {
    await element.scrollIntoViewIfNeeded()
    await (await frameElement.elementHandle())!.waitForElementState("stable")
    const outer = await frameElement.boundingBox()
    assert(outer)
    const size = await frameElement.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }))
    const inner = await element.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    const scale = outer.width / size.width, scaleY = outer.height / size.height
    // Locator coordinates across CSS-zoomed frames can omit the frame's scale.
    // Native mouse input uses the actual visiting viewport, as a person does.
    return { x: outer.x + inner.x * scale, y: outer.y + inner.y * scaleY, width: inner.width * scale, height: inner.height * scaleY, scale }
  }
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
  const buttonBox = await displayedBox(button)
  await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
  await page.waitForTimeout(50)
  assert.equal(await button.textContent(), "Add one: " + (before + 1))
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
  const drag = frame.locator("#native-drag"), box = await displayedBox(drag), scale = box.scale
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
