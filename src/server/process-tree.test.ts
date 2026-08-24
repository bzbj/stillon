import { describe, expect, test } from "bun:test"
import { collectProcessTree, descendantsOf, parseProcessTable } from "./process-tree"

describe("parseProcessTable", () => {
  test("maps parents to their children and ignores noise", () => {
    const table = parseProcessTable(["  100     1", "  200   100", "  300   200", "header junk", ""].join("\n"))
    expect(table.get(1)).toEqual([100])
    expect(table.get(100)).toEqual([200])
    expect(table.get(200)).toEqual([300])
  })
})

describe("descendantsOf", () => {
  test("walks the whole subtree, not just direct children", () => {
    // 100 -> 200 -> 300 is the shim -> native binary -> grandchild shape.
    const table = parseProcessTable(["  200   100", "  300   200", "  400   100", "  999     1"].join("\n"))
    expect(descendantsOf(100, table).sort()).toEqual([200, 300, 400])
  })

  test("returns nothing for a leaf process", () => {
    expect(descendantsOf(100, parseProcessTable("  200     1"))).toEqual([])
  })

  test("terminates when pid reuse creates a cycle", () => {
    const table = parseProcessTable(["  200   100", "  100   200"].join("\n"))
    expect(descendantsOf(100, table)).toEqual([200])
  })
})

describe("collectProcessTree", () => {
  // `ps` is POSIX-only. terminateChild() never calls this on Windows — it uses
  // the direct-child fallback there — so the walk is not exercised on win32.
  test.skipIf(process.platform === "win32")("includes the root and finds a real child process", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" })
    try {
      const tree = await collectProcessTree(process.pid)
      expect(tree[0]).toBe(process.pid)
      expect(tree).toContain(child.pid)
    } finally {
      child.kill()
    }
  })
})
