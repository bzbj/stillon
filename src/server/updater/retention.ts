import { randomUUID } from "node:crypto"
import { lstat, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { BUNDLE_FILE } from "../distribution/bundle"
import { atomicJson, exists, inside, json } from "./files"
import { desktopTransitionPending, FINISHED_PHASES, type UpdateControl, type UpdateDeployment, type UpdateState } from "./model"
import { processCommandLines } from "./processes"

/**
 * Bounded storage for managed installations.
 *
 * Package runtimes are immutable vendor files that can be downloaded again, so
 * only they are removed: source runtimes (customizations), quarantined data and
 * user data are never touched. The current runtime and the previous active one
 * stay available for rollback, together with everything referenced by updater
 * state, a running process or a recent write. Old transactions keep their
 * journals, patches and logs; only their data backups and probe homes go.
 */
export const RETENTION_FILE = "retention.json"
export const RETENTION_LOG = "retention-log.json"
/** Active runtimes kept: the current one and the previous rollback target. */
export const RETAINED_ACTIVE_RUNTIMES = 2
/** Finished transactions whose data backup is kept. */
export const RETAINED_TRANSACTION_BACKUPS = 2
/** Entries changed this recently may belong to an installer that is still staging. */
export const RETENTION_MIN_AGE_MS = 24 * 60 * 60 * 1000

interface RetentionState { schema: 1; active: string[] }

export interface RetentionResult {
  skipped?: string
  removedReleases: string[]
  removedControllers: string[]
  removedTransactionData: string[]
  failures: string[]
}

export interface RetentionOptions {
  now?: number
  minAgeMs?: number
  /** Full command lines of running processes; a referenced path is kept. */
  commandLines?: () => Promise<string[]>
}

const STATE_FILES = ["deployment.json", "control.json", "runner.json", "state.json", "request.json", "setup.json",
  "prepared-package.json", "desktop.json", "desktop-receipt.json", "service-registration.json"]

async function readText(file: string) {
  try { return await Bun.file(file).text() } catch { return "" }
}

/** Top-level entry under `directory` that contains `target`, or null. */
function topEntry(directory: string, target: string) {
  const relative = path.relative(path.resolve(directory), path.resolve(target))
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep)[0] ?? null
}

/** `releases/<name>` (bundle at its root) or `releases/<id>/<tag>` (bundle in its only child). */
async function isPackageRelease(entry: string) {
  const info = await lstat(entry)
  if (!info.isDirectory() || info.isSymbolicLink()) return false
  if (await exists(path.join(entry, BUNDLE_FILE))) return true
  const children = await readdir(entry, { withFileTypes: true })
  if (children.length !== 1 || !children[0].isDirectory()) return false
  const child = path.join(entry, children[0].name)
  return !await exists(path.join(child, ".git")) && await exists(path.join(child, BUNDLE_FILE))
}

async function newestChange(entry: string): Promise<number> {
  // The directory and its direct children change while an installer stages files.
  let newest = (await stat(entry)).mtimeMs
  for (const child of await readdir(entry)) {
    try { newest = Math.max(newest, (await lstat(path.join(entry, child))).mtimeMs) } catch { /* removed meanwhile */ }
  }
  return newest
}

async function removeTree(parent: string, name: string) {
  const target = inside(parent, name)
  // Rename first: an interrupted removal never leaves a partial tree under a live name.
  const trash = inside(parent, `.retired-${randomUUID()}`)
  await rename(target, trash)
  await rm(trash, { recursive: true, force: true })
}

/** Finish removals interrupted after their rename. */
async function clearRetired(parent: string) {
  if (!await exists(parent)) return
  for (const name of await readdir(parent)) {
    if (name.startsWith(".retired-")) await rm(inside(parent, name), { recursive: true, force: true }).catch(() => {})
  }
}

export async function pruneManagedStorage(deployment: UpdateDeployment, options: RetentionOptions = {}): Promise<RetentionResult> {
  const root = deployment.root
  const result: RetentionResult = { removedReleases: [], removedControllers: [], removedTransactionData: [], failures: [] }
  const now = options.now ?? Date.now()
  const minAge = options.minAgeMs ?? RETENTION_MIN_AGE_MS

  // Only an idle, settled installation is pruned.
  if (await exists(path.join(root, "request.json"))) return { ...result, skipped: "An update request is pending." }
  if (await desktopTransitionPending(root)) return { ...result, skipped: "A desktop migration is pending." }
  const statePath = path.join(root, "state.json")
  const state = await exists(statePath) ? await json<UpdateState>(statePath) : null
  if (state && !FINISHED_PHASES.has(state.phase)) return { ...result, skipped: "An update is in progress." }
  const setupPath = path.join(root, "setup.json")
  if (await exists(setupPath) && (await json<{ phase: string }>(setupPath)).phase !== "enabled") return { ...result, skipped: "Setup has not finished." }
  const control = await json<UpdateControl>(path.join(root, "control.json"))

  // Remember the active runtimes, so the previous one survives later failed attempts.
  const retentionPath = path.join(root, RETENTION_FILE)
  const saved = await exists(retentionPath) ? await json<RetentionState>(retentionPath).catch(() => null) : null
  const active = Array.isArray(saved?.active) ? saved.active.filter((item) => typeof item === "string") : []
  if (!active.length && state?.phase === "succeeded" && state.oldRuntime !== control.runtime) active.push(state.oldRuntime)
  if (active.at(-1) !== control.runtime) active.push(control.runtime)
  const retainedActive = active.slice(-RETAINED_ACTIVE_RUNTIMES)
  await atomicJson(retentionPath, { schema: 1, active: retainedActive } satisfies RetentionState)

  let commandLines: string[]
  try {
    commandLines = options.commandLines ? await options.commandLines()
      : (await processCommandLines(deployment.platform)).map((item) => item.command)
  } catch {
    return { ...result, skipped: "The process table could not be read." }
  }
  const references = (await Promise.all(STATE_FILES.map((name) => readText(path.join(root, name))))).join("\n")
    + "\n" + retainedActive.join("\n") + "\n" + (state ? [state.oldRuntime, state.newRuntime].join("\n") : "")
  const referenced = (directory: string, name: string) => {
    const full = path.join(directory, name)
    // JSON escapes Windows separators.
    const forms = [full, JSON.stringify(full).slice(1, -1)]
    return forms.some((form) => references.includes(form + path.sep) || references.includes(form + "/")
      || references.includes(form + "\\\\") || references.includes(form + "\"") || references.includes(form + "\n"))
      || commandLines.some((command) => command.includes(full))
  }
  const old = async (entry: string) => now - await newestChange(entry) >= minAge

  const releases = path.join(root, "releases")
  await clearRetired(releases)
  if (await exists(releases)) {
    for (const name of await readdir(releases)) {
      if (name.startsWith(".")) continue
      const entry = inside(releases, name)
      try {
        if (referenced(releases, name) || topEntry(releases, control.runtime) === name) continue
        if (!await isPackageRelease(entry) || !await old(entry)) continue
        await removeTree(releases, name)
        result.removedReleases.push(name)
      } catch (error) { result.failures.push(`releases/${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  const controllers = path.join(root, "controllers")
  await clearRetired(controllers)
  if (await exists(controllers)) {
    for (const name of await readdir(controllers)) {
      if (name.startsWith(".")) continue
      const entry = inside(controllers, name)
      try {
        if (referenced(controllers, name) || topEntry(controllers, deployment.controller) === name) continue
        if (!(await lstat(entry)).isDirectory() || !await old(entry)) continue
        await removeTree(controllers, name)
        result.removedControllers.push(name)
      } catch (error) { result.failures.push(`controllers/${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  const transactions = path.join(root, "transactions")
  if (await exists(transactions)) {
    const finished: { id: string; at: number }[] = []
    for (const id of await readdir(transactions)) {
      if (id.startsWith(".") || id === state?.id || references.includes(id)) continue
      const directory = inside(transactions, id)
      try {
        if (!(await lstat(directory)).isDirectory()) continue
        const journal = path.join(directory, "journal.json")
        const transition = path.join(directory, "desktop-transition.json")
        const record = await exists(journal) ? journal : await exists(transition) ? transition : null
        // A transaction without a journal may still be preparing.
        if (!record) continue
        const phase = (await json<{ phase?: string }>(record)).phase ?? ""
        if (!["prepared", "succeeded", "rolled-back", "failed"].includes(phase)) continue
        finished.push({ id, at: (await stat(record)).mtimeMs })
      } catch (error) { result.failures.push(`transactions/${id}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    finished.sort((a, b) => b.at - a.at)
    for (const { id, at } of finished.slice(RETAINED_TRANSACTION_BACKUPS)) {
      if (now - at < minAge) continue
      const directory = inside(transactions, id)
      for (const name of ["data", "probe"]) {
        try {
          if (!await exists(path.join(directory, name))) continue
          await removeTree(directory, name)
          result.removedTransactionData.push(`${id}/${name}`)
        } catch (error) { result.failures.push(`transactions/${id}/${name}: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
  }

  // Forget verification baselines of removed runtimes.
  const baselinesPath = path.join(root, "build-manifests.json")
  if (result.removedReleases.length && await exists(baselinesPath)) {
    const baselines = await json<Record<string, unknown>>(baselinesPath)
    let changed = false
    for (const runtime of Object.keys(baselines)) {
      const name = topEntry(releases, runtime)
      if (name && result.removedReleases.includes(name)) { delete baselines[runtime]; changed = true }
    }
    if (changed) await atomicJson(baselinesPath, baselines)
  }
  if (result.removedReleases.length || result.removedControllers.length || result.removedTransactionData.length || result.failures.length) {
    await atomicJson(path.join(root, RETENTION_LOG), { at: new Date(now).toISOString(), ...result })
  }
  return result
}
