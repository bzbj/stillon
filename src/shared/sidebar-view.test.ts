import { expect, test } from "bun:test"
import { parseSidebarViewSnapshot } from "./sidebar-view"

test("bootstrap keeps explicit expanded choices and rejects malformed preference data", () => {
  const view = { machineName: "Sample computer", workspaceCollapsed: { a: true, b: false }, workspaceCollapseVersions: { a: 2, b: 0 } }
  expect(parseSidebarViewSnapshot(view)).toEqual(view)
  for (const invalid of [
    null, [], {}, { ...view, machineName: "" },
    { ...view, workspaceCollapsed: [] }, { ...view, workspaceCollapsed: { b: "false" } },
    { ...view, workspaceCollapsed: JSON.parse('{"__proto__":true}') },
    { ...view, workspaceCollapseVersions: [] }, { ...view, workspaceCollapseVersions: { a: -1 } },
    { ...view, workspaceCollapseVersions: { a: "2" } }, { ...view, workspaceCollapseVersions: { unknown: 0 } },
  ]) expect(parseSidebarViewSnapshot(invalid)).toBeNull()
})
