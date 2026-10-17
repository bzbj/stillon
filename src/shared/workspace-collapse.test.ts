import { expect, test } from "bun:test"
import { applyWorkspaceCollapsePatch, mergeWorkspaceCollapsed, normalizeWorkspaceCollapsed } from "./workspace-collapse"

test("workspace fold normalization preserves explicit false and ignores legacy invalid values", () => {
  expect(normalizeWorkspaceCollapsed({ a: false, b: true, c: "false", d: null })).toEqual({ a: false, b: true })
  expect(normalizeWorkspaceCollapsed([true])).toEqual({})
  expect(normalizeWorkspaceCollapsed(JSON.parse('{"__proto__":true,"constructor":false,"safe":false}'))).toEqual({ safe: false })
})

test("per-node versions merge independent changes and validate every guard before writing", () => {
  expect(applyWorkspaceCollapsePatch({ a: true }, { a: 2 }, { b: false }, { b: 0 }))
    .toEqual({ workspaceCollapsed: { a: true, b: false }, workspaceCollapseVersions: { a: 2, b: 1 } })
  for (const expected of [{}, { a: -1 }, { b: 0 }, { a: 2, b: 0 }, [], { a: "2" }]) {
    expect(() => applyWorkspaceCollapsePatch({ a: true }, { a: 2 }, { a: false }, expected as never)).toThrow("versions")
  }
  expect(() => applyWorkspaceCollapsePatch({ a: true }, { a: 2 }, { a: false }, { a: 1 })).toThrow("changed")
})

test("workspace fold patches retain unrelated choices and reject a malformed patch atomically", () => {
  const current = { a: true, b: false }
  expect(mergeWorkspaceCollapsed(current, { a: false, c: true })).toEqual({ a: false, b: false, c: true })
  expect(() => mergeWorkspaceCollapsed(current, { a: false, b: "closed" } as never)).toThrow("true or false")
  expect(current).toEqual({ a: true, b: false })
})
