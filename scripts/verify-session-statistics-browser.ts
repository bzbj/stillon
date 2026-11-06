import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chromium, type Page } from "playwright"

const server = spawn("bun", ["./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5190", "--strictPort"], { stdio: "inherit" })
const url = "http://127.0.0.1:5190/scripts/test-fixtures/session-statistics/index.html"
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break } catch { /* startup */ }
  if (attempt > 100) { server.kill(); throw new Error("Statistics fixture did not start") }
  await new Promise(resolve => setTimeout(resolve, 100))
}
const browser = await chromium.launch({ channel: process.env.STILLON_TEST_BROWSER_CHANNEL || undefined }).catch(error => { server.kill(); throw error })
async function select(page: Page, chat: string) {
  await page.evaluate(chat => (window as any).fixture.select(chat), chat)
  await page.locator(`[data-fixture-chat="${chat}"]`).waitFor()
}
try {
  for (const width of [375, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    await page.goto(url)
    await page.getByRole("button", { name: "Session timing", exact: true }).waitFor()
    await page.locator("textarea").fill("Draft A")
    await select(page, "b")
    await page.locator("textarea").fill("Draft B")
    for (let i = 0; i < 30; i++) {
      const chat = i % 2 ? "b" : "a"
      await select(page, chat)
      assert.equal(await page.locator("[data-session-statistics]").count(), 1)
      assert.equal(await page.getByRole("button", { name: "Session timing", exact: true }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Session tokens", exact: true }).count(), 1)
      assert.equal(await page.locator("textarea").count(), 1)
      assert.equal(await page.locator("textarea").inputValue(), chat === "a" ? "Draft A" : "Draft B")
      assert.equal(await page.getByRole("button", { name: "Session timing", exact: true }).innerText(), chat === "a" ? "27 tok/s" : "200 tok/s")
    }
    await select(page, "a")
    const timing = page.getByRole("button", { name: "Session timing", exact: true })
    await timing.click()
    await page.getByText("Session average · updates after each measured model step", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.advance())
    await page.waitForFunction(() => document.querySelector('[aria-label="Session timing"][type="button"]')?.textContent?.includes("114 tok/s"))
    assert.equal(await page.getByRole("dialog", { name: "Session timing", exact: true }).innerText().then(text => text.includes("114")), true)
    const bounds = await page.getByRole("dialog", { name: "Session timing", exact: true }).boundingBox()
    assert(bounds && bounds.x >= 12 && bounds.x + bounds.width <= width - 12)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Session timing")
    await timing.click()
    await select(page, "b")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await select(page, "exec")
    assert.equal(await timing.innerText(), "— tok/s")
    await timing.click()
    await page.getByText(/Codex Exec does not report first-token timing/).waitFor()
    await page.keyboard.press("Escape")
    await select(page, "pending")
    await timing.click()
    await page.getByText("Waiting for a completed model step with first-token timing.", { exact: true }).waitFor()
    await page.evaluate(() => (window as any).fixture.visible(false))
    await page.waitForFunction(() => document.querySelector("[data-session-statistics]") === null)
    assert.equal(await page.getByRole("dialog").count(), 0)
    await select(page, "a")
    assert.equal(await page.locator("[data-session-statistics]").count(), 0)
    await page.evaluate(() => (window as any).fixture.visible(true))
    await timing.waitFor()
    assert.equal(await timing.innerText(), "114 tok/s")
    await select(page, "empty")
    assert.equal(await page.locator("[data-session-statistics]").count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.errors), [])
    console.log(`PASS statistics reconciliation, settlement updates, drafts, popovers and visibility (${width}px)`)
    await page.close()
  }
} finally { await browser.close(); server.kill() }
