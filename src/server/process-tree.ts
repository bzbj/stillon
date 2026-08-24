import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Parse `ps -Ao pid=,ppid=` output into a ppid -> child pids map. */
export function parseProcessTable(output: string): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }
  return children
}

/** Breadth-first walk of every descendant of `root`. */
export function descendantsOf(root: number, children: Map<number, number[]>): number[] {
  const found: number[] = []
  const queue = [root]
  const seen = new Set<number>([root])
  while (queue.length > 0) {
    const current = queue.shift() as number
    for (const child of children.get(current) ?? []) {
      // Guard against pid reuse producing a cycle.
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Snapshot `root` and everything beneath it.
 *
 * Must be taken *before* signalling: once a launcher shim exits, the native
 * binary it spawned is reparented to init and the parent link is lost.
 *
 * POSIX only — relies on `ps`. On Windows the caller falls back to signalling
 * the direct child, and this returns just `root` if it is called anyway.
 */
export async function collectProcessTree(root: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid="])
    return [root, ...descendantsOf(root, parseProcessTable(stdout))]
  } catch {
    // `ps` unavailable — fall back to just the process we were handed.
    return [root]
  }
}
