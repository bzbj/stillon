import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { previewNavigationScript } from "./preview-navigation"

test("preview links preserve canonical destinations through an older gateway base rewrite", () => {
  const canonical = "/api/projects/workspace/preview/reports/"
  const capability = "/_connect/preview-assets/cloud-token/"
  const script = previewNavigationScript(canonical).replaceAll(canonical, capability)
  let click: (event: unknown) => void = () => { throw new Error("No click listener") }
  const messages: unknown[] = []
  class Link {
    target = ""
    closest() { return this }
    hasAttribute() { return false }
    getAttribute() { return "chart.png" }
  }
  runInNewContext(script.replace(/^<script[^>]*>/u, "").replace(/<\/script>$/u, ""), {
    parent: { postMessage: (...args: unknown[]) => messages.push(args) }, window: {}, Element: Link, URL,
    document: { baseURI: "https://computer.example" + capability, addEventListener: (_type: string, handler: typeof click) => { click = handler } },
  })
  let prevented = false
  click({ button: 0, target: new Link(), preventDefault() { prevented = true } })
  expect(prevented).toBe(true)
  expect(messages).toEqual([[{ type: "stillon:preview-navigation", address: canonical + "chart.png" }, "https://computer.example"]])
})
