import { expect, test } from "bun:test"
import { staticallyUsedBy } from "../../scripts/startup-chunks"

test("startup chunk reachability handles shared/cyclic imports without pulling dynamic preview imports", () => {
  const main = "/project/src/main.tsx", workspace = "/project/src/client/app/AppRoot.tsx"
  const modules = new Map([
    ["react", { importers: [main, workspace] }],
    ["auth", { importers: [main] }],
    ["sidebar", { importers: [workspace, "cycle"] }],
    ["cycle", { importers: ["sidebar"] }],
    ["markdown", { importers: ["preview"] }],
    ["preview", { importers: [], dynamicImporters: [workspace] }],
  ])
  const graph = { getModuleInfo: (id: string) => modules.get(id) ?? null }
  expect(staticallyUsedBy("react", "/src/main.tsx", graph)).toBe(true)
  expect(staticallyUsedBy("sidebar", "/src/main.tsx", graph)).toBe(false)
  expect(staticallyUsedBy("cycle", "/src/client/app/AppRoot.tsx", graph)).toBe(true)
  expect(staticallyUsedBy("markdown", "/src/client/app/AppRoot.tsx", graph)).toBe(false)
  expect(staticallyUsedBy("C:\\project\\src\\main.tsx", "/src/main.tsx", graph)).toBe(true)
})
