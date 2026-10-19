import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chromium, firefox } from "playwright"

const port = 5190
const hostname = "h-00000000000000000000000000000000.localhost"
const route = "/scripts/test-fixtures/remote-auth/index.html"
const browserType = process.argv.includes("--firefox") ? firefox : chromium
const server = spawn("bun", ["scripts/test-fixtures/remote-auth/server.ts"], {
  stdio: "ignore",
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1_000) })).ok) break } catch { /* Starting fixture. */ }
    assert(attempt < 100, "Remote auth fixture did not start")
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  browser = await browserType.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`http://${hostname}:${port}${route}?hold-auth=1`, { timeout: 60_000 })
  await page.waitForFunction(() => (window as any).remoteAuthFixture?.pending.length === 1, undefined, { timeout: 60_000 })
  assert.equal(await page.locator("#draft").count(), 0, "Authentication must finish before mounting private content")
  assert.equal(await page.locator("dialog[open]").count(), 0, "Initial auth must not mount an extra checking shield")
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = false; fixture.release() })
  await page.evaluate(() => history.replaceState(null, "", location.pathname))
  await page.waitForFunction(() => (window as any).remoteAuthFixture?.mounts > 0 && !document.querySelector("dialog")?.open, undefined, { timeout: 60_000 })
  const state = () => page.evaluate(() => (window as any).remoteAuthFixture.state())
  async function focus(mode = "valid", event = "focus") {
    const target = await page.evaluate(({ mode, event }) => {
      const fixture = (window as any).remoteAuthFixture
      fixture.mode = mode
      const target = fixture.settled + 1
      window.dispatchEvent(new Event(event))
      return target
    }, { mode, event })
    await page.waitForFunction(target => {
      const fixture = (window as any).remoteAuthFixture
      return fixture.settled >= target && !document.querySelector("dialog")?.open
    }, target)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  }
  await page.evaluate(() => {
    (document.querySelector("#draft") as HTMLInputElement).value = "Unsent fixture draft"
    document.querySelector("#history")!.scrollTop = 500
  })
  const before = await state()
  assert.equal(before.viewRequests, 0, "Sidebar preferences must not gate authenticated workspace mounting")
  for (let attempt = 0; attempt < 5; attempt++) {
    await focus()
    const after = await state()
    for (const key of ["mounts", "unmounts", "draft", "scroll", "timeOrigin"]) assert.equal(after[key], before[key], key)
  }

  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = true; fixture.focus(); window.dispatchEvent(new Event("pageshow")) })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length === 1)
  assert.equal((await state()).checking, false, "Routine focus must revalidate in the background")
  await page.evaluate(() => { (window as any).remoteAuthFixture.hold = false; (window as any).remoteAuthFixture.release() })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length === 0)
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = true; window.dispatchEvent(new Event("stillon:check-session")) })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length === 1)
  assert.equal((await state()).checking, false, "Socket revalidation must leave the workspace visible")
  await page.locator("#draft").focus()
  assert.equal(await page.locator("#draft").evaluate(element => element === document.activeElement), true)
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = false; fixture.release() })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length === 0)
  await focus("valid", "stillon:check-session")
  assert.equal((await state()).mounts, before.mounts)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
  assert.equal((await state()).checking, false)
  await focus("valid", "pageshow")
  assert.equal((await state()).mounts, before.mounts, "Restoring a valid page must retain the workspace")

  await focus("view-error")
  assert.equal((await state()).checking, false, "Unavailable sidebar preferences must not hide an authenticated workspace")
  assert.equal((await state()).viewRequests, 0)
  assert.equal((await state()).draft, before.draft)

  for (const mode of ["network-error", "http-error", "malformed", "offline"]) {
    await focus(mode)
    const after = await state()
    for (const key of ["mounts", "unmounts", "draft", "scroll", "checkId", "resourceEpoch"]) assert.equal(after[key], before[key], key)
    assert.equal(after.checking, false)
    assert.equal(after.authStatus, "ready")
    const requests = after.requests
    await page.waitForTimeout(700)
    assert.equal((await state()).requests, requests, "Occasional failures must not schedule immediate retries")
  }
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.mode = "valid"; fixture.poll() })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.state().authStatus === "ready")
  const menu = page.getByRole("button", { name: "Synthetic Project workspace options", exact: true })
  const composer = page.getByPlaceholder("Build something...")
  await composer.fill("Unsent home draft")
  const originalComposer = await composer.elementHandle()
  const header = page.locator('[data-stillon-part="project-header"]')
  const bounds = await header.boundingBox()
  for (const status of ["connecting", "disconnected", "connected"]) {
    const originalMenu = await menu.elementHandle()
    await page.evaluate(status => (window as any).remoteAuthFixture.setConnection(status), status)
    await menu.waitFor({ state: "visible" })
    assert.equal(await originalMenu!.evaluate(element => element === document.querySelector('[aria-label="Synthetic Project workspace options"]')), true, "The menu button must stay mounted")
    assert.equal(await originalComposer!.evaluate(element => element.isConnected), true, "Reconnecting must keep the home composer mounted")
    assert.equal(await composer.inputValue(), "Unsent home draft")
    assert.deepEqual(await header.boundingBox(), bounds, "Connection changes must not reflow sidebar headers")
    assert.equal(await page.getByText("Reconnecting…", { exact: true }).count(), 0)
    await menu.click()
    await page.getByRole("menuitem", { name: "Copy Path", exact: true }).waitFor()
    await page.keyboard.press("Escape")
  }

  await page.evaluate(() => { (window as any).remoteAuthFixture.scope = "session-b" })
  await focus()
  await page.waitForFunction(() => (window as any).remoteAuthFixture.mounts === 2)
  assert.equal((await state()).draft, "", "Changing accounts must isolate private state")
  const beforeExpiry = await state()
  await focus("expired")
  await page.waitForSelector("#draft", { state: "detached" })
  assert.equal(await page.locator("#draft").count(), 0, "Expired authentication must unmount private content")
  assert.equal((await state()).unmounts, beforeExpiry.unmounts + 1)
  await focus()
  assert.equal((await state()).draft, "", "A new session must not resurrect the previous workspace")
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = true; fixture.focus() })
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length > 0)
  await page.evaluate(() => { (window as any).remoteAuthFixture.hold = false })
  await focus("expired", "stillon:check-session")
  await page.evaluate(() => (window as any).remoteAuthFixture.release())
  await page.waitForFunction(() => (window as any).remoteAuthFixture.pending.length === 0)
  assert.equal(await page.locator("#draft").count(), 0, "A stale successful response must not restore an expired session")
  await focus()
  await focus("offline")
  assert.equal(await page.locator("#draft").count(), 1, "A temporarily unavailable host must retain the authenticated workspace")

  await focus()
  await page.setViewportSize({ width: 412, height: 892 })
  let failuresLeft = 2
  const imageRequests: string[] = []
  await page.route("**/screenshot-light.png?*", async route => {
    imageRequests.push(route.request().url())
    if (failuresLeft-- > 0) await route.fulfill({ status: 503, body: "Temporarily unavailable", headers: { "Cache-Control": "no-store" } })
    else await route.continue()
  })
  const imageLoaded = () => page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="fixture-image.png"]')
    return image?.complete && image.naturalWidth > 0
  })
  await page.reload()
  await imageLoaded()
  assert.equal(imageRequests.length, 3, "A thumbnail must recover from temporary remote image failures without opening the modal")
  assert.ok(imageRequests.slice(1).every(url => new URL(url).searchParams.get("attachment") === "first"), "Retries must retain the original URL parameters")
  await page.locator('img[alt="fixture-image.png"]').click()
  await page.getByRole("dialog", { name: "fixture-image.png" }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img[alt="fixture-image.png"]')].every(image => image.naturalWidth > 0))
  await page.keyboard.press("Escape")

  failuresLeft = Infinity
  imageRequests.length = 0
  await page.reload()
  await page.getByRole("img", { name: "fixture-image.png preview unavailable" }).waitFor()
  assert.equal(imageRequests.length, 4, "Permanent failures must stop after three retries")
  failuresLeft = 0
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await imageLoaded()
  assert.equal(imageRequests.length, 5, "Reconnecting must recover an exhausted thumbnail")

  failuresLeft = Infinity
  imageRequests.length = 0
  await page.evaluate(() => (window as any).remoteAuthFixture.setImageSource("/screenshot-light.png?attachment=old"))
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="fixture-image.png"]')
    return image?.src.includes("attachment=old") && image.complete && !image.naturalWidth
  })
  failuresLeft = 0
  await page.evaluate(() => (window as any).remoteAuthFixture.setImageSource("/screenshot-light.png?attachment=new"))
  await imageLoaded()
  await page.waitForTimeout(700)
  assert.equal(imageRequests.filter(url => new URL(url).searchParams.get("attachment") === "old").length, 1, "Replacing the attachment must cancel the old retry")
  assert.equal(new URL(imageRequests.at(-1)!).searchParams.has("stillon-image-retry"), false, "A new attachment starts with a fresh retry budget")

  failuresLeft = Infinity
  await page.evaluate(() => (window as any).remoteAuthFixture.setImageSource("/screenshot-light.png?attachment=unmount"))
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="fixture-image.png"]')
    return image?.src.includes("attachment=unmount") && image.complete && !image.naturalWidth
  })
  await focus("expired")
  const requestsAtUnmount = imageRequests.length
  await page.waitForTimeout(700)
  assert.equal(imageRequests.length, requestsAtUnmount, "Session expiry must cancel pending image retries")
  console.log(`${browserType.name()} remote auth checks passed: stable background polls, focus/restore/reconnect state, sidebar geometry/menus, no transient shields/retry bursts, expiry and stale-response fencing.`)
  console.log(`${browserType.name()} attachment image checks passed: transient recovery, bounded retries, online recovery, modal preview, source changes and unmount cleanup.`)
} finally {
  await browser?.close()
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit")
    const force = setTimeout(() => server.kill("SIGKILL"), 5_000)
    server.kill("SIGTERM")
    try { await exited } finally { clearTimeout(force) }
  }
}
