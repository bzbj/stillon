import { execFile } from "node:child_process"
import { basename } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const POLL_INTERVAL_MS = 50

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

export interface ProcessInfo {
  pid: number
  ppid: number
  /** `ps` state. A leading "Z" marks a zombie: it has exited and holds nothing. */
  stat: string
  /** Start time as printed by `ps`. With the pid it names one process, so a reused pid is not mistaken for it. */
  startedAt: string
  command: string
}

// `lstart` is a fixed five-field date under LC_ALL=C, e.g. "Wed Sep 10 12:00:00 2026".
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

/** Parse `ps -Ao pid=,ppid=,stat=,lstart=,comm=` output. */
export function parseProcessList(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  for (const line of output.split("\n")) {
    const match = PROCESS_LINE.exec(line)
    if (!match) continue
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3]!,
      startedAt: match[4]!.replace(/\s+/g, " "),
      command: match[5]!.trim(),
    })
  }
  return processes
}

export class ProcessDiscoveryError extends Error {}

/** CIM supplies executable names (not command lines) and stable creation timestamps. */
export function parseWindowsProcessList(output: string): ProcessInfo[] {
  const value: unknown = JSON.parse(output.replace(/^\uFEFF/, ""))
  const rows = Array.isArray(value) ? value : [value]
  return rows.map((row) => {
    if (!row || !Number.isInteger(row.pid) || row.pid < 0
      || !Number.isInteger(row.ppid) || row.ppid < 0
      || typeof row.startedAt !== "string" || !row.startedAt
      || typeof row.command !== "string" || !row.command) {
      throw new ProcessDiscoveryError("could not list processes: invalid CIM process identity")
    }
    return { pid: row.pid, ppid: row.ppid, stat: "S", startedAt: row.startedAt, command: row.command }
  })
}

/** Every process on the machine, with enough detail to tell a reused pid apart. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  let stdout: string
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        + "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { "
        + "if ($null -eq $_.CreationDate) { throw 'Missing process creation time' }; "
        + "[pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; "
        + "startedAt = $_.CreationDate.ToUniversalTime().Ticks.ToString(); command = $_.Name } }) | ConvertTo-Json -Compress",
      ], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      const processes = parseWindowsProcessList(result.stdout)
      if (processes.length === 0) throw new ProcessDiscoveryError("CIM returned no processes")
      return processes
    }
    ;({ stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,stat=,lstart=,comm="], {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
    }))
  } catch (error) {
    throw new ProcessDiscoveryError(`could not list processes: ${error instanceof Error ? error.message : String(error)}`)
  }
  const processes = parseProcessList(stdout)
  if (processes.length === 0) {
    throw new ProcessDiscoveryError("could not list processes: ps returned nothing")
  }
  return processes
}

export interface ProcessControl {
  listProcesses: () => Promise<ProcessInfo[]>
  signal: (pid: number, signal: NodeJS.Signals) => void
  /** True while the pid exists. It may belong to a new process; only `listProcesses` can tell. */
  isPidPresent: (pid: number) => boolean
}

export const defaultProcessControl: ProcessControl = {
  listProcesses,
  signal(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone, or no longer ours to signal.
    }
  },
  isPidPresent(pid) {
    try {
      // Signal 0 performs the existence check without delivering anything.
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the pid exists but belongs to someone else.
      return (error as NodeJS.ErrnoException)?.code === "EPERM"
    }
  },
}

export interface OwnedProcess {
  pid: number
  startedAt: string
  command: string
}

/**
 * "tree": everything the run started, including tool commands.
 * "writer": only the Codex processes themselves — the launcher and the native
 * binary that holds the thread-writer lock — so a finished turn does not take
 * down background work its tools started.
 */
export type TerminationScope = "tree" | "writer"

export interface TerminateOwnedOptions {
  scope: TerminationScope
  /** Whether the direct child is still unreaped, so its pid cannot have been reused. */
  rootAlive: () => boolean
  graceMs: number
  killTimeoutMs: number
}

export class ProcessStopError extends Error {
  constructor(message: string, readonly survivors: number[]) {
    super(message)
  }
}

function isCodexExecutable(command: string) {
  return basename(command.split(/\s+/)[0] ?? "").toLowerCase().startsWith("codex")
}

function sameProcess(info: ProcessInfo | undefined, owned: OwnedProcess) {
  return Boolean(info && info.startedAt === owned.startedAt && !info.stat.startsWith("Z"))
}

/**
 * Tracks every process a spawned child started, across snapshots.
 *
 * A launcher shim can exit before its native child, which is then reparented
 * and unreachable through the tree. Recording identities (pid + start time)
 * as they are seen keeps those processes owned, and lets a later check tell
 * them apart from an unrelated process that happens to reuse the pid.
 */
export class ProcessOwnership {
  private readonly owned = new Map<number, OwnedProcess>()

  constructor(
    readonly rootPid: number,
    private readonly control: ProcessControl = defaultProcessControl,
  ) {}

  /** Record the current tree. Call it early, while the launcher still links to its children. */
  async record(rootAlive: boolean) {
    this.absorb(await this.control.listProcesses(), rootAlive)
  }

  /**
   * Stop the owned processes in `scope` and confirm they are gone.
   * Resolves only after a fresh process table shows no survivor; throws
   * `ProcessStopError` when that cannot be shown.
   */
  async terminate(options: TerminateOwnedOptions) {
    let targets: OwnedProcess[]
    try {
      targets = await this.refreshTargets(options)
    } catch (error) {
      if (!(error instanceof ProcessDiscoveryError)) throw error
      return await this.terminateWithoutDiscovery(options, error)
    }
    if (targets.length === 0) return

    // SIGTERM first so Codex can release its thread-writer lock on the way out.
    for (const target of targets) this.control.signal(target.pid, "SIGTERM")
    await this.waitUntilGone(targets, options.graceMs)

    // Re-read the table: it drops pids that were reused and picks up children
    // started while we waited. SIGKILL cannot be caught or forwarded by a shim,
    // which is why every owned pid is targeted individually.
    targets = await this.refreshTargets(options)
    if (targets.length > 0) {
      for (const target of targets) this.control.signal(target.pid, "SIGKILL")
      await this.waitUntilGone(targets, options.killTimeoutMs)
      targets = await this.refreshTargets(options)
    }

    if (targets.length > 0) {
      const pids = targets.map((target) => target.pid)
      throw new ProcessStopError(`process ${pids.join(", ")} is still running after SIGKILL`, pids)
    }
  }

  private async refreshTargets(options: TerminateOwnedOptions) {
    const processes = await this.control.listProcesses()
    this.absorb(processes, options.rootAlive())
    return this.live(processes, options.scope)
  }

  private absorb(processes: ProcessInfo[], rootAlive: boolean) {
    const byPid = new Map(processes.map((info) => [info.pid, info]))
    const children = new Map<number, number[]>()
    for (const info of processes) {
      // Windows retains ParentProcessId after the parent exits. If that pid
      // was reused, an older child must not be adopted by the new process.
      const parent = byPid.get(info.ppid)
      if (parent && /^\d+$/.test(info.startedAt) && /^\d+$/.test(parent.startedAt)
        && BigInt(info.startedAt) < BigInt(parent.startedAt)) continue
      const siblings = children.get(info.ppid)
      if (siblings) siblings.push(info.pid)
      else children.set(info.ppid, [info.pid])
    }

    const root = byPid.get(this.rootPid)
    if (root && rootAlive && !this.owned.has(this.rootPid)) {
      this.adopt(root)
    }

    for (const owned of [...this.owned.values()]) {
      if (!sameProcess(byPid.get(owned.pid), owned)) continue
      for (const pid of descendantsOf(owned.pid, children)) {
        const info = byPid.get(pid)
        if (info) this.adopt(info)
      }
    }
  }

  private adopt(info: ProcessInfo) {
    const known = this.owned.get(info.pid)
    if (known?.startedAt === info.startedAt) return
    this.owned.set(info.pid, { pid: info.pid, startedAt: info.startedAt, command: info.command })
  }

  private live(processes: ProcessInfo[], scope: TerminationScope) {
    const byPid = new Map(processes.map((info) => [info.pid, info]))
    return [...this.owned.values()].filter((owned) => (
      sameProcess(byPid.get(owned.pid), owned)
      && (scope === "tree" || owned.pid === this.rootPid || isCodexExecutable(owned.command))
    ))
  }

  private async waitUntilGone(targets: OwnedProcess[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!targets.some((target) => this.control.isPidPresent(target.pid))) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  /**
   * Without a process table, descendants cannot be found and a recorded pid
   * cannot be told apart from a reused one. Signal only the unreaped direct
   * child, which is certainly ours, and then refuse to call a tree stop
   * confirmed. A finished turn whose Codex processes have all vanished is
   * still provably released: a pid that no longer exists cannot be a writer.
   */
  private async terminateWithoutDiscovery(options: TerminateOwnedOptions, cause: ProcessDiscoveryError) {
    if (options.rootAlive()) {
      this.control.signal(this.rootPid, "SIGTERM")
      if (!(await this.waitUntilGone([{ pid: this.rootPid, startedAt: "", command: "" }], options.graceMs))) {
        this.control.signal(this.rootPid, "SIGKILL")
        await this.waitUntilGone([{ pid: this.rootPid, startedAt: "", command: "" }], options.killTimeoutMs)
      }
    }

    const remaining = [...this.owned.values()]
      .filter((owned) => options.scope === "tree" || owned.pid === this.rootPid || isCodexExecutable(owned.command))
      .filter((owned) => this.control.isPidPresent(owned.pid))
      .map((owned) => owned.pid)
    if (options.scope === "writer" && remaining.length === 0 && !options.rootAlive()) return

    throw new ProcessStopError(cause.message, remaining)
  }
}
