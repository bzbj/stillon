import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { chromium, firefox, type Browser } from "playwright"
import { clickDirectFileLink } from "./verify-direct-file-input"

// Native input into an isolated, scaled iframe; no application or user data.
async function serve(html: string) {
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html) })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  return { port: (server.address() as { port: number }).port,
    stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
const child = await serve(`<!doctype html><style>body{margin:24px}button{position:absolute;left:24px;top:120px;width:160px;height:44px}</style><button id="add">0</button><script>document.querySelector('button').onclick=e=>{if(e.isTrusted)e.currentTarget.textContent=Number(e.currentTarget.textContent)+1}</script>`)
const parent = await serve(`<!doctype html><style>body{margin:0}#preview{position:absolute;left:72px;top:96px;width:600px;height:500px;overflow:hidden}iframe{border:0;transform-origin:top left}</style><div id="preview" aria-busy="false"><iframe title="HTML file preview" sandbox="allow-scripts allow-same-origin" src="http://localhost:${child.port}/"></iframe></div>`)
const type = process.argv.includes("--firefox") ? firefox : chromium
let browser: Browser | undefined
try {
  browser = await type.launch({ headless: true, ...(type === chromium ? { channel: process.platform === "win32" ? "msedge" : "chromium" } : {}) })
  console.log(JSON.stringify({ browser: type.name(), version: browser.version(), platform: process.platform }))
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${parent.port}/`)
  const button = page.frameLocator('iframe[title="HTML file preview"]').locator("#add")
  await button.waitFor()
  for (const scale of [1, .5, .85, 1.5]) {
    await page.locator("iframe").evaluate((frame, scale) => { Object.assign((frame as HTMLElement).style, { transform: `scale(${scale})`, width: `${100 / scale}%`, height: `${100 / scale}%` }) }, scale)
    for (const background of [false, true]) {
      const other = background ? await context.newPage() : null
      // Shift the frame after another tab has taken focus, as when the loading
      // status is removed and a standalone preview closes.
      await page.locator("#preview").evaluate((element, background) => {
        (element as HTMLElement).style.top = background ? "48px" : "96px"
      }, background)
      const before = Number(await button.innerText())
      await clickDirectFileLink(page, button)
      assert.equal(await button.innerText(), String(before + 1), "Native click must reach the frame exactly once")
      await other?.close()
      console.log(`PASS ${type.name()} isolated iframe scale=${scale} background=${background}`)
    }
  }
  const before = await button.innerText()
  await page.evaluate(() => {
    const overlay = document.createElement("div"); overlay.id = "blocker"
    Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "100", background: "transparent" })
    document.body.append(overlay)
  })
  assert.equal(await page.evaluate(() => document.elementFromPoint(10, 10)?.id), "blocker", "The test overlay must cover the parent viewport")
  await assert.rejects(clickDirectFileLink(page, button), /Native pointer did not reach the HTML preview element/)
  assert.equal(await button.innerText(), before, "Occlusion must fail before sending a click")
  await page.locator("#blocker").evaluate(element => element.remove())
  await clickDirectFileLink(page, button)
  assert.equal(await button.innerText(), String(Number(before) + 1))
  console.log(`PASS ${type.name()} occlusion remains a bounded failure; removal restores one native click`)
} finally { await browser?.close(); await parent.stop(); await child.stop() }
