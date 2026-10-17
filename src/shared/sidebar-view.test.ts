import { expect, test } from "bun:test"
import { parseSidebarViewSnapshot } from "./sidebar-view"

test("bootstrap keeps explicit expanded choices and rejects malformed preference data", () => {
  const view = { machineName: "Sample computer", workspaceCollapsed: { a: true, b: false }, sidebarCollapsed: false }
  expect(parseSidebarViewSnapshot(view)).toEqual(view)
  for (const invalid of [
    null, [], {}, { ...view, sidebarCollapsed: "false" }, { ...view, machineName: "" },
    { ...view, workspaceCollapsed: [] }, { ...view, workspaceCollapsed: { b: "false" } },
    { ...view, workspaceCollapsed: JSON.parse('{"__proto__":true}') },
  ]) expect(parseSidebarViewSnapshot(invalid)).toBeNull()
})
