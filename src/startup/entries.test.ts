import { expect, test } from "bun:test"
import path from "node:path"
import { serveStaticAsset } from "../server/static-assets"

function controllerUrl(html: string) {
  const match = html.match(/<script src="(\/assets\/startup-[a-f0-9]{12}\.js)"><\/script>/)
  expect(match).not.toBeNull()
  return match![1]!
}

test("built local host serves critical HTML and its independent controller with correct MIME", async () => {
  const dist = path.resolve("dist/client")
  const index = await serveStaticAsset(dist, new Request("http://127.0.0.1/"), "/")
  expect(index?.status).toBe(200)
  const html = await index!.text()
  expect(html).toContain('id="stillon-startup" data-mode="host"')
  expect(html).toContain('media="print" data-stillon-styles')
  expect(html).toMatch(/rel="modulepreload"[^>]+href="\/assets\/workspace-[a-f0-9]{12}\.js"/)
  const url = controllerUrl(html)
  const controller = await serveStaticAsset(dist, new Request(`http://127.0.0.1${url}`), url)
  expect(controller?.status).toBe(200)
  expect(controller?.headers.get("content-type")).toContain("javascript")
  expect(await controller!.text()).toContain("window.StillOnStartup")
})
