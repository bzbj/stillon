import { describe, expect, test } from "bun:test"
import {
  collectProcessTree,
  descendantsOf,
  parseProcessList,
  parseProcessTable,
  parseWindowsProcessList,
  ProcessDiscoveryError,
  ProcessOwnership,
  ProcessStopError,
  type ProcessControl,
  type ProcessInfo,
} from "./process-tree"

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

describe("parseProcessList", () => {
  test("reads pid, parent, state, start time and a command with spaces", () => {
    const processes = parseProcessList([
      "  101     1 Ss   Mon Sep  7 22:38:24 2026     /sbin/launchd",
      "52913   629 Z    Wed Sep 10 11:52:47 2026     node /Users/me/My Tools/index.js",
      "garbage",
    ].join("\n"))

    expect(processes).toEqual([
      { pid: 101, ppid: 1, stat: "Ss", startedAt: "Mon Sep 7 22:38:24 2026", command: "/sbin/launchd" },
      { pid: 52913, ppid: 629, stat: "Z", startedAt: "Wed Sep 10 11:52:47 2026", command: "node /Users/me/My Tools/index.js" },
    ])
  })

  test("parses this machine's process output", async () => {
    const { listProcesses } = await import("./process-tree")
    const processes = await listProcesses()
    expect(processes.some((info) => info.pid === process.pid)).toBe(true)
  }, 15_000)
})

describe("parseWindowsProcessList", () => {
  test("keeps creation timestamps exact and handles singleton CIM output", () => {
    expect(parseWindowsProcessList('\uFEFF{"pid":10,"ppid":2,"startedAt":"639249167258774070","command":"codex.exe"}'))
      .toEqual([{ pid: 10, ppid: 2, stat: "S", startedAt: "639249167258774070", command: "codex.exe" }])
  })

  test("rejects missing creation times instead of trusting a reusable pid", () => {
    expect(() => parseWindowsProcessList('[{"pid":10,"ppid":2,"command":"codex.exe"}]'))
      .toThrow(ProcessDiscoveryError)
  })
})

function info(pid: number, ppid: number, command: string, startedAt = "Wed Sep 10 12:00:00 2026", stat = "S"): ProcessInfo {
  return { pid, ppid, stat, startedAt, command }
}

/** An in-memory process table. A signal in `exitsOn` removes the process. */
function fakeProcesses(initial: ProcessInfo[], exitsOn: NodeJS.Signals[] = ["SIGTERM", "SIGKILL"]) {
  let table = [...initial]
  const signals: Array<[number, NodeJS.Signals]> = []
  const control: ProcessControl = {
    listProcesses: async () => [...table],
    signal(pid, signal) {
      signals.push([pid, signal])
      if (exitsOn.includes(signal)) table = table.filter((entry) => entry.pid !== pid)
    },
    isPidPresent: (pid) => table.some((entry) => entry.pid === pid),
  }
  return {
    control,
    signals,
    set(next: ProcessInfo[]) {
      table = [...next]
    },
  }
}

const quick = { graceMs: 20, killTimeoutMs: 20 }

describe("ProcessOwnership", () => {
  test("does not adopt an older Windows child whose parent pid was reused", async () => {
    const processes = fakeProcesses([
      info(100, 50, "node.exe", "200"),
      info(101, 100, "codex.exe", "100"),
      info(102, 100, "codex.exe", "201"),
    ])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.terminate({ scope: "tree", rootAlive: () => true, ...quick })
    expect(processes.signals).toEqual([[100, "SIGTERM"], [102, "SIGTERM"]])
  })

  test("Windows writer cleanup retains native ownership after the shim exits and preserves tools", async () => {
    const processes = fakeProcesses([
      info(100, 50, "node.exe", "639249167258774070"),
      info(101, 100, "codex.exe", "639249167258774071"),
      info(102, 101, "powershell.exe", "639249167258774072"),
    ])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.record(true)
    processes.set([
      info(100, 50, "unrelated.exe", "639249167258774090"),
      info(101, 100, "codex.exe", "639249167258774071"),
      info(102, 101, "powershell.exe", "639249167258774072"),
    ])
    await ownership.terminate({ scope: "writer", rootAlive: () => false, ...quick })
    expect(processes.signals).toEqual([[101, "SIGTERM"]])
  })

  test("still stops a native child after its launcher exited and it was reparented", async () => {
    const processes = fakeProcesses([info(100, 50, "node"), info(101, 100, "/opt/codex/bin/codex")])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.record(true)

    // The launcher is gone and the native child now hangs off init.
    processes.set([info(101, 1, "/opt/codex/bin/codex"), info(102, 1, "unrelated")])
    await ownership.terminate({ scope: "tree", rootAlive: () => false, ...quick })

    expect(processes.signals).toEqual([[101, "SIGTERM"]])
  })

  test("never signals a pid that now belongs to a different process", async () => {
    const processes = fakeProcesses([info(100, 50, "node"), info(101, 100, "/opt/codex/bin/codex")])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.record(true)

    processes.set([info(101, 1, "someone-else", "Wed Sep 10 13:00:00 2026")])
    await ownership.terminate({ scope: "tree", rootAlive: () => false, ...quick })

    expect(processes.signals).toEqual([])
  })

  test("escalates to SIGKILL and reports survivors instead of claiming success", async () => {
    const processes = fakeProcesses([info(100, 50, "node"), info(101, 100, "/opt/codex/bin/codex")], [])
    const ownership = new ProcessOwnership(100, processes.control)

    const stopped = ownership.terminate({ scope: "tree", rootAlive: () => true, ...quick })
    await expect(stopped).rejects.toBeInstanceOf(ProcessStopError)
    await expect(stopped).rejects.toMatchObject({ survivors: [100, 101] })
    expect(processes.signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGTERM", "SIGKILL", "SIGKILL"])
  })

  test("treats zombies as exited", async () => {
    const processes = fakeProcesses([info(100, 50, "node"), info(101, 100, "codex", undefined, "Z")])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.terminate({ scope: "tree", rootAlive: () => true, ...quick })
    expect(processes.signals).toEqual([[100, "SIGTERM"]])
  })

  test("writer scope stops lingering Codex processes but leaves tool processes alone", async () => {
    const processes = fakeProcesses([
      info(100, 50, "node"),
      info(101, 100, "/opt/codex/bin/codex"),
      info(102, 101, "/bin/zsh"),
      info(103, 102, "npm run dev"),
    ])
    const ownership = new ProcessOwnership(100, processes.control)
    await ownership.record(true)

    processes.set([
      info(101, 1, "/opt/codex/bin/codex"),
      info(102, 101, "/bin/zsh"),
      info(103, 102, "npm run dev"),
    ])
    await ownership.terminate({ scope: "writer", rootAlive: () => false, ...quick })

    expect(processes.signals).toEqual([[101, "SIGTERM"]])
  })

  test("a run cannot be confirmed stopped without a process table", async () => {
    const processes = fakeProcesses([info(100, 50, "node")])
    const control: ProcessControl = {
      ...processes.control,
      listProcesses: async () => {
        throw new ProcessDiscoveryError("could not list processes: ps missing")
      },
    }
    const ownership = new ProcessOwnership(100, control)

    await expect(ownership.terminate({ scope: "tree", rootAlive: () => true, ...quick }))
      .rejects.toBeInstanceOf(ProcessStopError)
    // The direct child is certainly ours, so it is still asked to stop.
    expect(processes.signals).toEqual([[100, "SIGTERM"]])
  })

  test("a finished run whose Codex processes are gone is released even without a process table", async () => {
    const control: ProcessControl = {
      listProcesses: async () => {
        throw new ProcessDiscoveryError("could not list processes: ps missing")
      },
      signal() {},
      isPidPresent: () => false,
    }
    const ownership = new ProcessOwnership(100, control)
    await ownership.terminate({ scope: "writer", rootAlive: () => false, ...quick })
  })
})
