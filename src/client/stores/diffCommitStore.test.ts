import { beforeEach, describe, expect, test } from "bun:test"
import { isDiffPathChecked, migrateDiffCommitStore, useDiffCommitStore } from "./diffCommitStore"

describe("diffCommitStore", () => {
  beforeEach(() => {
    useDiffCommitStore.setState({ selectionsByProjectId: {} })
  })

  test("defaults paths to checked without storing them", () => {
    useDiffCommitStore.getState().reconcileProject("project-1", ["a.ts", "b.ts"])

    expect(useDiffCommitStore.getState().selectionsByProjectId).toEqual({})
    expect(isDiffPathChecked(undefined, "a.ts")).toBe(true)
  })

  test("stores unchecked exceptions when most paths are selected", () => {
    useDiffCommitStore.getState().setChecked("project-1", "a.ts", false)
    useDiffCommitStore.getState().setChecked("project-1", "b.ts", true)

    const selection = useDiffCommitStore.getState().selectionsByProjectId["project-1"]
    expect(selection).toEqual({
      mode: "all",
      exceptions: {
        "a.ts": false,
      },
    })
    expect(isDiffPathChecked(selection, "a.ts")).toBe(false)
    expect(isDiffPathChecked(selection, "b.ts")).toBe(true)
  })

  test("stores checked exceptions when most paths are unselected", () => {
    useDiffCommitStore.getState().setAllChecked("project-1", ["a.ts", "b.ts", "c.ts"], false)
    useDiffCommitStore.getState().setChecked("project-1", "b.ts", true)

    const selection = useDiffCommitStore.getState().selectionsByProjectId["project-1"]
    expect(selection).toEqual({
      mode: "none",
      exceptions: {
        "b.ts": true,
      },
    })
    expect(isDiffPathChecked(selection, "a.ts")).toBe(false)
    expect(isDiffPathChecked(selection, "b.ts")).toBe(true)
  })

  test("removes all-selected project state", () => {
    useDiffCommitStore.getState().setAllChecked("project-1", ["a.ts", "b.ts"], false)
    useDiffCommitStore.getState().setAllChecked("project-1", ["a.ts", "b.ts"], true)

    expect(useDiffCommitStore.getState().selectionsByProjectId).toEqual({})
  })

  test("keeps all-unselected project state compactly", () => {
    useDiffCommitStore.getState().setAllChecked("project-1", ["a.ts", "b.ts"], false)

    expect(useDiffCommitStore.getState().selectionsByProjectId).toEqual({
      "project-1": {
        mode: "none",
        exceptions: {},
      },
    })
  })

  test("reconcile prunes stale exceptions", () => {
    useDiffCommitStore.getState().setAllChecked("project-1", ["a.ts", "b.ts"], false)
    useDiffCommitStore.getState().setChecked("project-1", "a.ts", true)
    useDiffCommitStore.getState().reconcileProject("project-1", ["b.ts", "c.ts"])

    expect(useDiffCommitStore.getState().selectionsByProjectId).toEqual({
      "project-1": {
        mode: "none",
        exceptions: {},
      },
    })
  })

  test("migration compacts old full checked path snapshots to the smaller side", () => {
    expect(migrateDiffCommitStore({
      checkedPathsByProjectId: {
        "project-mostly-checked": {
          "a.ts": true,
          "b.ts": true,
          "c.ts": false,
        },
        "project-mostly-unchecked": {
          "a.ts": false,
          "b.ts": false,
          "c.ts": true,
        },
      },
    }, 2)).toEqual({
      selectionsByProjectId: {
        "project-mostly-checked": {
          mode: "all",
          exceptions: {
            "c.ts": false,
          },
        },
        "project-mostly-unchecked": {
          mode: "none",
          exceptions: {
            "c.ts": true,
          },
        },
      },
    })
  })

  test("migration keeps interim sparse unchecked snapshots in all mode", () => {
    expect(migrateDiffCommitStore({
      checkedPathsByProjectId: {
        "project-1": {
          "a.ts": false,
          "b.ts": false,
        },
      },
    }, 3)).toEqual({
      selectionsByProjectId: {
        "project-1": {
          mode: "all",
          exceptions: {
            "a.ts": false,
            "b.ts": false,
          },
        },
      },
    })
  })
})
