import { expect, test } from "bun:test"
import { PreviewResources, LOCAL_PREVIEW_ASSET_PREFIX, REMOTE_PREVIEW_ASSET_PREFIX } from "./preview-resources"

test("preview capabilities expire, revoke and remain confined to the HTML folder", () => {
  let now = 0, valid = true
  const resources = new PreviewResources(LOCAL_PREVIEW_ASSET_PREFIX, () => now)
  const context = resources.create("workspace", "output/demo/index.html", () => valid)
  expect(resources.resolve(context.assetPrefix + "assets/app.mjs")?.path).toBe("/api/projects/workspace/preview/output/demo/assets/app.mjs")
  for (const file of ["../secret.json", "%2e%2e%2fsecret.json", ".env", "assets/.config.json", "file.txt", "C%3a/secret.json", "a%5cb.js", "%zz.js"]) {
    expect(resources.resolve(context.assetPrefix + file)).toBeNull()
  }
  valid = false
  expect(resources.resolve(context.assetPrefix + "app.js")).toBeNull()
  valid = true; now = 3_600_001
  expect(resources.resolve(context.assetPrefix + "app.js")).toBeNull()
})

test("cloud wrapping replaces the local base and navigation bridge without changing the opaque sandbox", async () => {
  const local = new PreviewResources(LOCAL_PREVIEW_ASSET_PREFIX)
  const localContext = local.create("workspace", "reports/index.html")
  const localResponse = await local.wrap(new Response('<!doctype html><html><title>Report</title><a href="chart.png"><img src="chart.png"></a></html>', {
    headers: { "content-type": "text/html" },
  }), new Request("http://127.0.0.1:3210/api/projects/workspace/preview/reports/index.html"), localContext, "reports/index.html")
  const cloud = new PreviewResources(REMOTE_PREVIEW_ASSET_PREFIX)
  const context = cloud.create("workspace", "reports/index.html")
  const response = await cloud.wrap(localResponse, new Request("https://computer.example/api/projects/workspace/preview/reports/index.html"), context, "reports/index.html")
  const html = await response.text()
  expect(html.match(/<base /gu)).toHaveLength(1)
  expect(html.match(/<script data-stillon-preview-navigation>/gu)).toHaveLength(1)
  expect(html).toContain(`<base href="${context.assetPrefix}">`)
  expect(html).not.toContain(localContext.assetPrefix)
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-downloads")
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin")
})
