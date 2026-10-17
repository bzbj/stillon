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
  await page.goto(`http://${hostname}:${port}${route}`, { timeout: 60_000 })
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
  }
  await page.evaluate(() => {
    (document.querySelector("#draft") as HTMLInputElement).value = "Unsent fixture draft"
    document.querySelector("#history")!.scrollTop = 500
  })
  const before = await state()
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
  await page.waitForSelector("dialog[open]")
  await page.keyboard.press("Escape")
  assert.equal((await state()).checking, true, "Escape must not dismiss revalidation")
  const shield = await page.evaluate(() => {
    const dialog = document.querySelector("dialog")!
    ;(document.querySelector("#private-portal") as HTMLButtonElement).focus()
    const rect = dialog.getBoundingClientRect()
    return { modal: dialog.matches(":modal"), backgroundFocused: document.activeElement?.id === "private-portal",
      opaque: getComputedStyle(dialog).backgroundColor !== "rgba(0, 0, 0, 0)",
      fullScreen: rect.width >= innerWidth && rect.height >= innerHeight }
  })
  assert.deepEqual(shield, { modal: true, backgroundFocused: false, opaque: true, fullScreen: true })
  await page.evaluate(() => { const fixture = (window as any).remoteAuthFixture; fixture.hold = false; fixture.release() })
  await page.waitForFunction(() => !document.querySelector("dialog")?.open)
  assert.equal((await state()).mounts, before.mounts)
  assert.equal((await state()).draft, before.draft)

  await focus("valid", "stillon:check-session")
  assert.equal((await state()).mounts, before.mounts, "A valid socket recheck must retain the workspace")
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
  assert.equal((await state()).checking, true)
  await focus("valid", "pageshow")
  assert.equal((await state()).mounts, before.mounts, "Restoring a valid page must retain the workspace")

  for (const mode of ["network-error", "http-error"]) {
    await page.evaluate(mode => { const fixture = (window as any).remoteAuthFixture; fixture.mode = mode; fixture.focus() }, mode)
    await page.waitForFunction(() => (window as any).remoteAuthFixture.state().checking)
    assert.equal((await state()).mounts, before.mounts)
    await focus()
    assert.equal((await state()).draft, before.draft)
  }

  await focus("expired")
  assert.equal(await page.locator("#draft").count(), 0, "Expired authentication must unmount private content")
  assert.equal((await state()).unmounts, before.unmounts + 1)
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
  assert.equal(await page.locator("#draft").count(), 0, "An unavailable host must not expose the private workspace")
  console.log(`${browserType.name()} remote auth checks passed: retained focus/restore/reconnect state, modal portal shield, fail-closed retries, expiry and stale-response fencing.`)
} finally {
  await browser?.close()
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit")
    const force = setTimeout(() => server.kill("SIGKILL"), 5_000)
    server.kill("SIGTERM")
    try { await exited } finally { clearTimeout(force) }
  }
}
