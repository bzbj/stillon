import { expect, test } from "bun:test"
import { PreviewResources, LOCAL_PREVIEW_ASSET_PREFIX } from "./preview-resources"

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
