import assert from "node:assert/strict"
import type { Page } from "playwright"

/** Uses native keyboard/IME and pointer dispatch on the visiting browser. The
 * application reports revisioned state, so asynchronous reports cannot rewind it. */
export async function verifyPreviewInput(options: {
  page: Page; appOrigin: string; name: string; direct?: boolean; chromium: boolean
  prepare: (address: string) => Promise<void>; stage: (name: string) => void; screenshot: string
}) {
  const { page, appOrigin, name, direct, chromium, prepare } = options
  const sentInputs: object[] = []
  const key = name + "-" + Date.now()
  const state = async () => await (await fetch(appOrigin + "/input-state?case=" + encodeURIComponent(key))).json() as any
  const wait = async (predicate: (value: any) => boolean) => {
    const until = Date.now() + 15_000
    let value: any
    do { value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 80)) } while (Date.now() < until)
    throw new Error("Input state did not settle: " + JSON.stringify(value).slice(0, 400) + "; recent inputs: " + JSON.stringify(sentInputs.slice(-6)))
  }
  const textRequests: string[] = []
  const record = (request: import("playwright").Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/preview-browser/")) {
      const action = request.postDataJSON()
      if (action?.type === "text") textRequests.push(action.text)
      if (action?.type === "text" || action?.type === "key") sentInputs.push({ type: action.type, text: action.text?.slice(0, 30), key: action.key })
    }
  }
  page.on("request", record)
  const cdp = chromium ? await page.context().newCDPSession(page) : undefined
  const image = page.getByAltText("Interactive browser preview")
  const point = async (x: number, y: number) => {
    if (direct) return { x, y }
    await page.waitForFunction(() => { const value = document.querySelector('img[alt="Interactive browser preview"]') as HTMLImageElement; return value?.complete && value.naturalWidth > 0 })
    const rect = await image.boundingBox(); assert(rect)
    const size = await image.evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }))
    return { x: rect.x + x * rect.width / size.width, y: rect.y + y * rect.height / size.height }
  }
  try {
    options.stage(name + ":text")
    await prepare(appOrigin + "/input?case=" + encodeURIComponent(key))
    if (!direct) await image.waitFor()
    await wait(value => value.revision > 0)
    const editor = await point(50, 120)
    await page.mouse.click(editor.x, editor.y)
    if (!direct) await page.getByLabel("Preview keyboard input").waitFor({ state: "attached" })
    let expected = "hello "
    await page.keyboard.type(expected)
    await wait(value => value.text === expected)
    for (const [parts, committed] of [[ ["n", "ni"], "你" ], [ ["に", "にほ"], "日本語" ]] as const) {
      if (cdp) {
        for (const text of parts) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
        await cdp.send("Input.insertText", { text: committed })
      } else {
        // Firefox has no CDP IME driver. Exercise its composition event order;
        // keep the distinction from native IME evidence explicit in results.
        const input = direct ? page.getByLabel("Application text") : page.getByLabel("Preview keyboard input")
        await input.evaluate((element: HTMLTextAreaElement, values) => {
          element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
          for (const text of values.parts) {
            setter.call(element, (values.direct ? element.value.replace(/(?:n|ni|に|にほ)$/u, "") : "") + text)
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true, data: text }))
          }
          setter.call(element, (values.direct ? element.value.replace(/(?:ni|にほ)$/u, "") : "") + values.committed)
          element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: values.committed }))
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: values.committed }))
        }, { parts, committed, direct: Boolean(direct) })
      }
      expected += committed
      await wait(value => value.text === expected)
    }
    await page.keyboard.insertText("😀"); expected += "😀"
    await wait(value => value.text === expected)
    const paste = async (value: string) => {
      if (direct) await page.keyboard.insertText(value)
      else await page.getByLabel("Preview keyboard input").evaluate((element, text) => {
        // Firefox protects DataTransfer data outside a trusted paste. Supply the
        // event's read interface explicitly; exercise the actual paste handler
        // without accessing either operating system clipboard.
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true })
        Object.defineProperty(event, "clipboardData", { value: { getData: (format: string) => format === "text/plain" ? text : "" } })
        element.dispatchEvent(event)
      }, value)
      expected += value; await wait(value => value.text === expected)
    }
    // A visiting-device paste event, without reading/writing the OS clipboard.
    await paste(" paste文")
    if (!direct) {
      assert.equal(textRequests.filter(value => value === "你").length, 1)
      assert.equal(textRequests.filter(value => value === "日本語").length, 1)
      assert(!textRequests.includes("n") && !textRequests.includes("ni"))
    }
    await paste("x".repeat(1999) + "😀" + "y".repeat(100))
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
    await page.keyboard.press("Backspace")
    await wait(value => value.text === "")
    await page.keyboard.insertText("Ready 你好 😀")
    await wait(value => value.text === "Ready 你好 😀")

    options.stage(name + ":mouse-drag-scaled")
    if (!direct) await image.evaluate(element => { element.style.width = "75%" })
    let start = await point(50, 230), end = await point(200, 230)
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up()
    const dragged = await wait(value => value.dragMoves > 0 && !value.down)
    assert(Math.abs(dragged.dragX - 150) <= 2, "Scaled mouse drag must preserve 150 CSS px")
    assert.equal(dragged.pointerType, "mouse")
    await page.screenshot({ path: options.screenshot })

    if (!direct) {
      options.stage(name + ":capture-release")
      const capturedEvent = page.waitForEvent("console", { predicate: message => message.text().startsWith("fixture-capture:") })
      await image.evaluate(element => element.addEventListener("gotpointercapture", event => console.log("fixture-capture:" + (event as PointerEvent).pointerId), { once: true }))
      start = await point(200, 230)
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 1, start.y)
      await wait(value => value.down)
      const captured = Number((await capturedEvent).text().slice(16))
      assert(captured >= 0, "The visiting image must capture its pointer")
      await image.evaluate((element, id) => element.releasePointerCapture(id), captured)
      await page.mouse.move(start.x + 2, start.y)
      await wait(value => !value.down && value.ups >= 2)
      await page.mouse.up()
    }
    if (cdp) {
      options.stage(name + ":touch-drag-cancel")
      const before = await state()
      start = await point(50 + before.dragX, 230); end = await point(110 + before.dragX, 230)
      const touch = (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", location = start) => cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: ["touchEnd", "touchCancel"].includes(type) ? [] : [{ ...location, id: 7 }],
      })
      await touch("touchStart"); await touch("touchMove", end); await touch("touchEnd")
      const moved = await wait(value => value.pointerType === "touch" && !value.down && value.dragMoves > before.dragMoves)
      assert(Math.abs(moved.dragX - before.dragX - 60) <= 2, "Scaled touch drag must preserve 60 CSS px")
      start = await point(50 + moved.dragX, 230)
      await touch("touchStart"); await wait(value => value.down)
      await touch("touchCancel")
      await wait(value => !value.down && value.cancels > 0)
    }
    return { nativeIme: Boolean(cdp), nativeTouch: Boolean(cdp), paste: direct ? "native text baseline" : "scripted visiting-device paste handler; OS clipboard untouched" }
  } finally { page.off("request", record); await cdp?.detach() }
}
