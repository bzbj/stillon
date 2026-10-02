import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium, type Page } from "playwright"
import { spawn } from "node:child_process"

const artifactDir = process.env.STILLON_TEST_ARTIFACT_DIR ?? "test-artifacts/async-answer"
await mkdir(artifactDir, { recursive: true })
const server = spawn("bun", ["./node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5189", "--strictPort"], { stdio: "inherit" })
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch("http://127.0.0.1:5189/scripts/test-fixtures/async-answer/index.html", { signal: AbortSignal.timeout(1000) })).ok) break } catch { /* server startup */ }
  if (attempt > 100) { server.kill(); throw new Error("Fixture server did not start") }
  await new Promise((resolve) => setTimeout(resolve, 100))
}
console.log("Fixture ready; launching browser")
const browser = await chromium.launch({ channel: process.env.STILLON_TEST_BROWSER_CHANNEL || undefined }).catch((error) => { server.kill(); throw error })
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", hasTouch: true })
context.setDefaultTimeout(5_000)
const failures: string[] = []
async function control(page: Page, expression: string) {
  await page.evaluate((source) => { Function(source)() }, expression)
}
async function text(page: Page, value: string) { await page.getByText(value, { exact: true }).first().waitFor() }
async function fill(page: Page, value = "keep it short") {
  await page.getByRole("radio", { name: "HTML", exact: true }).check()
  await page.getByRole("textbox", { name: "Any constraints? 的答案" }).fill(value)
}
async function send(page: Page) { await page.getByRole("button", { name: "发送", exact: true }).click() }
async function count(page: Page, type = "chat.answerAsyncQuestion") {
  return page.evaluate((type) => (window as any).fixture.commands.filter((entry: any) => entry.command.type === type).length, type)
}
async function scenario(name: string, run: (page: Page) => Promise<void>) {
  const page = await context.newPage()
  try {
    await page.goto("http://127.0.0.1:5189/scripts/test-fixtures/async-answer/index.html")
    await text(page, "需要你的回答")
    await run(page)
    console.log(`PASS ${name}`)
  } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`) }
  finally { await page.close() }
}
try {
  await scenario("T01/T02 immediate feedback, synchronous duplicate guard, frozen answers", async (page) => {
    await fill(page)
    await page.getByRole("button", { name: "发送", exact: true }).evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); button.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
    await text(page, "答案：HTML")
    await text(page, "答案：keep it short")
    assert.equal(await page.getByRole("button", { name: "发送中…", exact: true }).isDisabled(), true)
    assert.equal(await page.locator("fieldset:not([disabled])").count(), 0)
    assert.equal(await count(page), 1)
    assert.equal(await page.getByRole("status").getAttribute("aria-live"), "polite")
  })
  await scenario("T02 keyboard repeat", async (page) => {
    await fill(page)
    const button = page.getByRole("button", { name: "发送", exact: true })
    await button.focus()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Space")
    assert.equal(await count(page), 1)
  })
  await scenario("T02 touchscreen repeated activation", async (page) => {
    await fill(page)
    const box = await page.getByRole("button", { name: "发送", exact: true }).boundingBox()
    assert(box)
    for (let tap = 0; tap < 3; tap++) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    assert.equal(await count(page), 1)
  })
  await scenario("T03 incomplete and whitespace; custom option answer", async (page) => {
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true)
    await fill(page, "   ")
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true)
    await page.getByRole("radio", { name: "其他（自行填写）" }).check()
    await page.getByRole("textbox", { name: "Choose a format 的答案" }).fill("CSV")
    await page.getByRole("textbox", { name: "Any constraints? 的答案" }).fill("synthetic")
    await send(page)
    await text(page, "答案：CSV")
    assert.equal(await count(page), 1)
  })
  for (const status of ["accepted", "queued"]) for (const first of ["ack", "snapshot"]) {
    await scenario(`T04 ${first} first; late submitting cannot regress ${status}`, async (page) => {
      await fill(page); await send(page)
      await control(page, `fixture.record('${status}'); fixture.${first === "ack" ? `ack('${status}')` : "snapshot()"}`)
      await text(page, status === "accepted" ? "已发送" : "已排队")
      await control(page, first === "ack" ? "fixture.record('submitting'); fixture.snapshot()" : "fixture.ack('submitting')")
      await text(page, status === "accepted" ? "已发送" : "已排队")
      assert.equal(await page.getByRole("button").count(), 0)
      assert.equal(await count(page), 1)
    })
  }
  await scenario("T05 click disconnected; original outbound envelope flushes once", async (page) => {
    await control(page, "fixture.disconnect()")
    await fill(page); await send(page)
    await text(page, "等待连接恢复…")
    assert.equal(await count(page), 0)
    await control(page, "fixture.reconnect()")
    await text(page, "答案：HTML")
    assert.equal(await count(page), 1)
    await control(page, "fixture.ack('accepted')")
    await text(page, "已发送")
  })
  await scenario("T06 open but silent after 10s; no failure or blind resend", async (page) => {
    await page.clock.install()
    await control(page, "fixture.queryMode('drop')")
    await fill(page); await send(page)
    await page.clock.fastForward(10_001)
    await text(page, "尚未确认送达")
    await text(page, "正在核对发送状态…")
    assert.equal(await count(page), 1)
    assert.equal(await count(page, "chat.getAsyncQuestionResponse"), 1)
    await page.clock.fastForward(10_001)
    await text(page, "暂时无法核对，请恢复连接后重试核对。")
    assert.equal(await count(page), 1)
  })
  await scenario("T07 accepted with lost ACK; reconnect queries without resend", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.record('accepted'); fixture.disconnect()")
    await text(page, "等待连接恢复…")
    assert.equal(await page.getByRole("button", { name: "等待连接…", exact: true }).isDisabled(), true)
    await control(page, "fixture.reconnect()")
    await text(page, "已发送")
    assert.equal(await count(page), 1)
    assert.equal(await count(page, "chat.getAsyncQuestionResponse"), 1)
  })
  await scenario("T08 queued across disconnect/remount/refresh then accepted", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.record('queued'); fixture.snapshot()")
    await text(page, "已排队")
    await control(page, "fixture.disconnect(); fixture.mount(false)")
    await page.getByText("需要你的回答", { exact: true }).waitFor({ state: "hidden" })
    await control(page, "fixture.mount(true); fixture.reconnect()")
    await text(page, "已排队")
    await page.reload(); await text(page, "已排队")
    await text(page, "答案：keep it short")
    assert.equal(await count(page), 0)
    // New runtime still gets eventual server fact through snapshot.
    await control(page, `fixture.commands.push({command:{type:'chat.answerAsyncQuestion',chatId:'chat-fixture',questionKey:JSON.stringify(['thread-fixture','turn-fixture','item-fixture']),submissionId:'server',answers:[{index:0,value:'HTML'},{index:1,value:'keep it short'}]}}); fixture.record('accepted'); fixture.snapshot()`)
    await text(page, "已发送")
  })
  await scenario("T09 unknown check fails then succeeds; no direct resend", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.record('delivery_unknown'); fixture.ack('delivery_unknown'); fixture.queryMode('drop')")
    await text(page, "发送结果待核实")
    await page.getByRole("button", { name: "核对状态", exact: true }).click()
    await text(page, "核对中…")
    await control(page, "fixture.snapshot()")
    assert.equal(await page.getByRole("button", { name: "核对中…", exact: true }).isDisabled(), true)
    assert.equal(await count(page, "chat.getAsyncQuestionResponse"), 1)
    await control(page, "fixture.queryReply(true)")
    await text(page, "暂时无法核对，请恢复连接后重试核对。")
    assert.equal(await page.getByRole("button", { name: "重新发送" }).count(), 0)
    await control(page, "fixture.record('accepted'); fixture.queryMode('record')")
    await page.getByRole("button", { name: "核对状态", exact: true }).click()
    await text(page, "已发送")
    assert.equal(await count(page), 1)
    assert.equal(await count(page, "chat.getAsyncQuestionResponse"), 2)
  })
  await scenario("T10 explicit failed, preserve/edit draft, new submission ID", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.ack('failed')")
    await text(page, "发送失败")
    const input = page.getByRole("textbox", { name: "Any constraints? 的答案" })
    assert.equal(await input.inputValue(), "keep it short")
    assert.equal(await page.getByRole("radio", { name: "HTML", exact: true }).isChecked(), true)
    await input.fill("edited")
    await page.getByRole("button", { name: "重新发送", exact: true }).click()
    await control(page, "fixture.ack('accepted')")
    await text(page, "答案：edited")
    const ids = await page.evaluate(() => (window as any).fixture.commands.filter((entry: any) => entry.command.type === "chat.answerAsyncQuestion").map((entry: any) => entry.command.submissionId))
    assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1])
  })
  await scenario("T11 original chat binding and unresolved reload", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.chat('other-chat')")
    await page.getByRole("textbox", { name: "Any constraints? 的答案" }).waitFor()
    assert.equal(await page.getByRole("textbox").count(), 1)
    await control(page, "fixture.chat('chat-fixture')")
    await text(page, "答案：keep it short")
    assert.equal(await count(page), 1)
    await page.reload()
    await text(page, "发送结果待核实")
    await text(page, "答案：keep it short")
    assert.equal(await count(page), 0)
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).count(), 0)
  })
  await scenario("T13 other client fact wins without overriding its answer", async (page) => {
    await fill(page); await send(page)
    await control(page, "fixture.record('accepted', {submissionId:'other-client', answers:[{index:0,value:'Markdown'},{index:1,value:'other answer'}]}); fixture.snapshot(); fixture.ack('submitting')")
    await text(page, "答案：other answer")
    await text(page, "已发送")
    assert.equal(await count(page), 1)
  })
  await scenario("T14 read-only unknown/failed histories have answers and no actions", async (page) => {
    await fill(page); await send(page)
    for (const status of ["delivery_unknown", "failed"]) {
      await control(page, `fixture.record('${status}'); fixture.snapshot(); fixture.readOnly(true)`)
      await text(page, "答案：keep it short")
      assert.equal(await page.getByRole("button").count(), 0)
    }
  })
  await scenario("T15 mobile widths/long answers/reduced motion/focus", async (page) => {
    await fill(page, "Synthetic".repeat(80)); await send(page)
    await control(page, "fixture.longQuestions()")
    await page.locator("legend").first().filter({ hasText: "SyntheticLongQuestion".repeat(50) }).waitFor()
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 812 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    assert.equal(await page.locator(".animate-spin").first().evaluate((element) => getComputedStyle(element).animationName), "none")
    await control(page, "fixture.ack('accepted')")
    await text(page, "已发送")
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY")
  })
  await scenario("T16 opt-in diagnostics exclude answer/question/error content", async (page) => {
    const logs: string[] = []
    page.on("console", (message) => { if (message.text().includes("[stillon/async-answer]")) logs.push(message.text()) })
    await control(page, "sessionStorage.setItem('stillon:debug-async-answers','1')")
    await fill(page, "PRIVATE_SENTINEL"); await send(page)
    await control(page, "fixture.ack('accepted')")
    await text(page, "已发送")
    assert(logs.some((value) => value.includes("command_sent")))
    assert(logs.some((value) => value.includes("ack")))
    assert(logs.every((value) => !/PRIVATE_SENTINEL|Choose a format|Any constraints/.test(value)))
  })
  // Capture actual component states for desktop and mobile review.
  for (const width of [1280, 375]) {
    for (const state of ["sending", "waiting", "queued", "accepted", "failed", "delivery_unknown"]) {
      await scenario(`screenshot ${width} ${state}`, async (page) => {
        await page.setViewportSize({ width, height: 812 })
        await fill(page); await send(page)
        if (state === "waiting") { await control(page, "fixture.disconnect()"); await text(page, "等待连接恢复…") }
        else if (state !== "sending") {
          await control(page, `fixture.ack('${state}')`)
          await text(page, { queued: "已排队", accepted: "已发送", failed: "发送失败", delivery_unknown: "发送结果待核实" }[state]!)
        }
        await page.screenshot({ path: `${artifactDir}/${width}-${state}.png`, fullPage: true })
      })
    }
  }
} finally { await context.close(); await browser.close(); server.kill() }
assert.deepEqual(failures, [], `Browser acceptance failures: ${failures.join(", ")}`)
