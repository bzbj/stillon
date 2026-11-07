import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { once } from "node:events"
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import { chromium, firefox, type Browser } from "playwright"
import { clickDirectFileLink } from "./verify-direct-file-input"

// Render the actual component with isolated entry/capability responses.
const child = createHttpServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" })
  response.end('<!doctype html><button id="add" style="position:absolute;left:24px;top:120px;width:160px;height:44px">0</button><script>document.querySelector("button").onclick=e=>{if(e.isTrusted)e.currentTarget.textContent=Number(e.currentTarget.textContent)+1}</script>')
})
child.listen(0, "127.0.0.1"); await once(child, "listening")
const childOrigin = `http://localhost:${(child.address() as { port: number }).port}`
const vite = await createServer({ configFile: false, root: process.cwd(), plugins: [react()],
  cacheDir: "test-artifacts/direct-html-layout-vite", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
let browser: Browser | undefined
try {
  await vite.listen()
  const port = (vite.httpServer!.address() as { port: number }).port
  const type = process.argv.includes("--firefox") ? firefox : chromium
  browser = await type.launch({ headless: true, ...(type === chromium ? { channel: process.platform === "win32" ? "msedge" : "chromium" } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route("**/api/link-capabilities", route => route.fulfill({ json: { local: true, isMac: false, filePreviewProtocol: 1 } }))
  await context.route("**/api/file-previews/fixture/entry", route => route.fulfill({ json: { protocol: 1, url: childOrigin + "/index.html" } }))
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${port}/scripts/test-fixtures/direct-html-layout/index.html`)
  const iframe = page.locator('iframe[title="HTML file preview"]'), frame = page.frameLocator('iframe[title="HTML file preview"]')
  await frame.locator("#add").waitFor()
  const loading = await iframe.boundingBox(); assert(loading)
  await frame.locator("body").evaluate(() => parent.postMessage({ type: "stillon:file-ready" }, "*"))
  await iframe.locator("..").and(page.locator('[aria-busy="false"]')).waitFor()
  const ready = await iframe.boundingBox(); assert(ready)
  assert.deepEqual(ready, loading, "Removing the loading notice must not move or resize the iframe")
  await clickDirectFileLink(page, frame.locator("#add"))
  assert.equal(await frame.locator("#add").innerText(), "1")
  await frame.locator("body").evaluate(() => parent.postMessage({ type: "stillon:file-dependency-error", label: "fixture.css" }, "*"))
  await page.getByRole("button", { name: "Dismiss dependency warning", exact: true }).waitFor()
  assert.deepEqual(await iframe.boundingBox(), ready, "Dependency warnings must not shift the iframe")
  await page.getByRole("button", { name: "Dismiss dependency warning", exact: true }).click()
  assert.deepEqual(await iframe.boundingBox(), ready)
  await frame.locator("body").evaluate(() => parent.postMessage({ type: "stillon:file-service-link", address: "http://localhost:43210/" }, "*"))
  await page.getByRole("button", { name: "Dismiss", exact: true }).waitFor()
  assert.deepEqual(await iframe.boundingBox(), ready, "Linked-file notices must not shift the iframe")
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  assert.deepEqual(await iframe.boundingBox(), ready)
  await clickDirectFileLink(page, frame.locator("#add"))
  assert.equal(await frame.locator("#add").innerText(), "2")
  console.log(`PASS ${type.name()} actual DirectHtmlPreview keeps iframe geometry across loading, warnings and linked actions; native clicks apply once`)
} finally {
  await browser?.close(); await vite.close()
  await new Promise<void>((resolve, reject) => child.close(error => error ? reject(error) : resolve()))
}
