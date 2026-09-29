import { describe, expect, test } from "bun:test"
import type { SidebarProjectGroup } from "../../shared/types"
import { resolveHomeProject } from "./defaultProject"

const groups = [
  { groupKey: "finance", title: "Finance" },
  { groupKey: "developer", title: "Developer" },
] as SidebarProjectGroup[]

describe("home project selection", () => {
  test("uses the saved default when no project was selected for this visit", () => {
    expect(resolveHomeProject(groups, null, "developer")?.groupKey).toBe("developer")
  })

  test("a one-time selection takes priority without changing the saved default", () => {
    expect(resolveHomeProject(groups, "finance", "developer")?.groupKey).toBe("finance")
  })

  test("falls back only to a visible sidebar project when a project disappears", () => {
    expect(resolveHomeProject(groups, "hidden", "removed")?.groupKey).toBe("finance")
    expect(resolveHomeProject([], "hidden", "removed")).toBeNull()
  })
})
