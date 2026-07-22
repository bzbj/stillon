import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import type { Dirent, Stats } from "node:fs"
import { open, readFile, readdir, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"

const DISCOVERY_UPDATE_BATCH_SIZE = 25
const SESSION_METADATA_READ_CHUNK_BYTES = 16 * 1024
const MAX_SESSION_METADATA_LINE_BYTES = 1024 * 1024
export const PROJECT_DISCOVERY_CACHE_TTL_MS = 60_000

function isMissingPathError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

export interface DiscoveredProject {
  localPath: string
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface ProjectDiscoveryAdapter {
  provider: AgentProvider
  scan(homeDir?: string): ProviderDiscoveredProject[]
  scanIncrementally?(
    homeDir?: string,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<ProviderDiscoveredProject>
}

export interface IncrementalProjectDiscoveryOptions {
  initialProjects?: Iterable<DiscoveredProject>
  signal?: AbortSignal
  onUpdate?: (
    projects: DiscoveredProject[],
    progress: { complete: boolean }
  ) => void | Promise<void>
  updateBatchSize?: number
}

function resolveEncodedClaudePath(folderName: string) {
  const encodePath = (localPath: string) => localPath.replace(/[^a-zA-Z0-9]/g, "-")
  const hasEncodedPathPrefix = (localPath: string) => {
    const encodedPath = encodePath(localPath)
    return process.platform === "win32"
      ? folderName.toLowerCase().startsWith(encodedPath.toLowerCase())
      : folderName.startsWith(encodedPath)
  }
  const isEncodedPath = (localPath: string) => {
    const encodedPath = encodePath(localPath)
    return process.platform === "win32"
      ? folderName.toLowerCase() === encodedPath.toLowerCase()
      : folderName === encodedPath
  }
  const windowsDrive = /^([a-z])--/i.exec(folderName)?.[1]
  const rootPath = windowsDrive
    ? path.parse(`${windowsDrive}:\\`).root
    : folderName.startsWith("-")
      ? path.parse("/").root
      : null
  if (!rootPath) return null

  const startingPaths = [...new Set([
    process.cwd(),
    homedir(),
    tmpdir(),
    rootPath,
  ].map((candidate) => path.resolve(candidate)))]
    .filter(hasEncodedPathPrefix)
    .sort((left, right) => encodePath(right).length - encodePath(left).length)

  const visited = new Set<string>()
  const visit = (currentPath: string): string | null => {
    const normalizedCurrentPath = path.resolve(currentPath)
    if (visited.has(normalizedCurrentPath)) return null
    visited.add(normalizedCurrentPath)

    if (isEncodedPath(normalizedCurrentPath)) return normalizedCurrentPath
    if (!hasEncodedPathPrefix(normalizedCurrentPath)) return null

    let entries
    try {
      entries = readdirSync(normalizedCurrentPath, { withFileTypes: true })
    } catch {
      return null
    }

    const candidates = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(normalizedCurrentPath, entry.name))
      .filter((candidate) => folderName.startsWith(encodePath(candidate)))
      .sort((left, right) => right.length - left.length)

    for (const candidate of candidates) {
      const resolved = visit(candidate)
      if (resolved) return resolved
    }
    return null
  }

  for (const startingPath of startingPaths) {
    const resolved = visit(startingPath)
    if (resolved) return resolved
  }
  return null
}

function normalizeExistingDirectory(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!statSync(normalized).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

async function normalizeExistingDirectoryAsync(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!(await stat(normalized)).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

export function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.localPath)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.localPath, {
        localPath: project.localPath,
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export function mergeIncrementalDiscoveryUpdate(args: {
  currentProjects: Iterable<DiscoveredProject>
  discoveredProjects: Iterable<DiscoveredProject>
  savedProjects: Iterable<DiscoveredProject>
  complete: boolean
}) {
  return mergeDiscoveredProjects([
    ...(args.complete ? [] : args.currentProjects),
    ...args.discoveredProjects,
    ...args.savedProjects,
  ])
}

export function isProjectDiscoverySnapshotFresh(
  completedAt: number | null,
  now = Date.now(),
  ttlMs = PROJECT_DISCOVERY_CACHE_TTL_MS
) {
  return completedAt !== null && now - completedAt < ttlMs
}

export class ClaudeProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "claude" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!existsSync(projectsDir)) {
      return []
    }

    const entries = readdirSync(projectsDir, { withFileTypes: true })
    const projects: ProviderDiscoveredProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const resolvedPath = resolveEncodedClaudePath(entry.name)
      if (!resolvedPath) continue
      const normalizedPath = normalizeExistingDirectory(resolvedPath)
      if (!normalizedPath) {
        continue
      }

      const stat = statSync(path.join(projectsDir, entry.name))
      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: stat.mtimeMs,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }

  async *scanIncrementally(
    homeDir: string = homedir(),
    options: { signal?: AbortSignal } = {}
  ): AsyncIterable<ProviderDiscoveredProject> {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    let directoryEntries: Dirent[]
    try {
      directoryEntries = await readdir(projectsDir, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }

    const entries: Array<{
      entry: Dirent
      markerStat: Stats
    }> = []
    for (const entry of directoryEntries) {
      if (!entry.isDirectory()) continue
      try {
        entries.push({
          entry,
          markerStat: await stat(path.join(projectsDir, entry.name)),
        })
      } catch (error) {
        if (!isMissingPathError(error)) throw error
      }
    }
    entries.sort((left, right) => right.markerStat.mtimeMs - left.markerStat.mtimeMs)

    for (const { entry, markerStat } of entries) {
      options.signal?.throwIfAborted()
      const resolvedPath = resolveEncodedClaudePath(entry.name)
      if (!resolvedPath) continue
      const normalizedPath = await normalizeExistingDirectoryAsync(resolvedPath)
      if (!normalizedPath) continue

      yield {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: markerStat.mtimeMs,
      }
    }
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readCodexSessionIndex(indexPath: string) {
  const updatedAtById = new Map<string, number>()
  if (!existsSync(indexPath)) {
    return updatedAtById
  }

  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = updatedAtById.get(id)
    if (existing === undefined || updatedAt > existing) {
      updatedAtById.set(id, updatedAt)
    }
  }

  return updatedAtById
}

function collectCodexSessionFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectCodexSessionFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath)
    }
  }
  return files
}

function readCodexConfiguredProjects(configPath: string) {
  const projects = new Map<string, number>()
  if (!existsSync(configPath)) {
    return projects
  }

  const configMtime = statSync(configPath).mtimeMs
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

function readCodexSessionMetadata(sessionsDir: string) {
  const metadataById = new Map<string, { cwd: string; modifiedAt: number }>()

  for (const sessionFile of collectCodexSessionFiles(sessionsDir)) {
    const fileStat = statSync(sessionFile)
    const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0]
    if (!firstLine?.trim()) continue

    const record = parseJsonRecord(firstLine)
    if (!record || record.type !== "session_meta") continue

    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue

    const payloadRecord = payload as Record<string, unknown>
    const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
    const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
    if (!sessionId || !cwd) continue

    const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
    const modifiedAt = [recordTimestamp, payloadTimestamp, fileStat.mtimeMs].find((value) => !Number.isNaN(value)) ?? fileStat.mtimeMs

    metadataById.set(sessionId, { cwd, modifiedAt })
  }

  return metadataById
}

async function readCodexSessionIndexAsync(indexPath: string) {
  const updatedAtById = new Map<string, number>()
  let content
  try {
    content = await readFile(indexPath, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return updatedAtById
    throw error
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = updatedAtById.get(id)
    if (existing === undefined || updatedAt > existing) {
      updatedAtById.set(id, updatedAt)
    }
  }

  return updatedAtById
}

async function readCodexConfiguredProjectsAsync(configPath: string) {
  const projects = new Map<string, number>()
  let configStat
  let content
  try {
    [configStat, content] = await Promise.all([
      stat(configPath),
      readFile(configPath, "utf8"),
    ])
  } catch (error) {
    if (isMissingPathError(error)) return projects
    throw error
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configStat.mtimeMs)
  }

  return projects
}

async function *collectCodexSessionFilesIncrementally(
  directory: string,
  signal?: AbortSignal
): AsyncIterable<string> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => right.name.localeCompare(left.name))
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for (const entry of entries) {
    signal?.throwIfAborted()
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* collectCodexSessionFilesIncrementally(fullPath, signal)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield fullPath
    }
  }
}

async function readFirstLine(filePath: string, signal?: AbortSignal) {
  const handle = await open(filePath, "r")
  const chunks: Buffer[] = []
  let totalBytes = 0

  try {
    while (totalBytes < MAX_SESSION_METADATA_LINE_BYTES) {
      signal?.throwIfAborted()
      const buffer = Buffer.allocUnsafe(Math.min(
        SESSION_METADATA_READ_CHUNK_BYTES,
        MAX_SESSION_METADATA_LINE_BYTES - totalBytes
      ))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes)
      if (bytesRead === 0) {
        return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "")
      }

      const content = buffer.subarray(0, bytesRead)
      const newlineIndex = content.indexOf(10)
      if (newlineIndex >= 0) {
        chunks.push(content.subarray(0, newlineIndex))
        return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "")
      }
      chunks.push(content)
      totalBytes += bytesRead
    }

    return null
  } finally {
    await handle.close()
  }
}

export class CodexProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "codex" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const updatedAtById = readCodexSessionIndex(indexPath)
    const metadataById = readCodexSessionMetadata(sessionsDir)
    const configuredProjects = readCodexConfiguredProjects(configPath)
    const projects: ProviderDiscoveredProject[] = []

    for (const [sessionId, metadata] of metadataById.entries()) {
      const modifiedAt = updatedAtById.get(sessionId) ?? metadata.modifiedAt
      const cwd = metadata.cwd
      if (!cwd) {
        continue
      }
      if (!path.isAbsolute(cwd)) {
        continue
      }

      const normalizedPath = normalizeExistingDirectory(cwd)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    for (const [configuredPath, modifiedAt] of configuredProjects.entries()) {
      if (!path.isAbsolute(configuredPath)) {
        continue
      }

      const normalizedPath = normalizeExistingDirectory(configuredPath)
      if (!normalizedPath) {
        continue
      }

      projects.push({
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }

  async *scanIncrementally(
    homeDir: string = homedir(),
    options: { signal?: AbortSignal } = {}
  ): AsyncIterable<ProviderDiscoveredProject> {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const [updatedAtById, configuredProjects] = await Promise.all([
      readCodexSessionIndexAsync(indexPath),
      readCodexConfiguredProjectsAsync(configPath),
    ])

    for (const [configuredPath, modifiedAt] of [...configuredProjects.entries()]
      .sort((left, right) => right[1] - left[1])) {
      options.signal?.throwIfAborted()
      if (!path.isAbsolute(configuredPath)) continue
      const normalizedPath = await normalizeExistingDirectoryAsync(configuredPath)
      if (!normalizedPath) continue

      yield {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      }
    }

    for await (const sessionFile of collectCodexSessionFilesIncrementally(sessionsDir, options.signal)) {
      options.signal?.throwIfAborted()
      let fileStat
      let firstLine
      try {
        [fileStat, firstLine] = await Promise.all([
          stat(sessionFile),
          readFirstLine(sessionFile, options.signal),
        ])
      } catch (error) {
        if (isMissingPathError(error)) continue
        throw error
      }
      if (!firstLine?.trim()) continue

      const record = parseJsonRecord(firstLine)
      if (!record || record.type !== "session_meta") continue
      const payload = record.payload
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue

      const payloadRecord = payload as Record<string, unknown>
      const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
      const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
      if (!sessionId || !cwd || !path.isAbsolute(cwd)) continue

      const normalizedPath = await normalizeExistingDirectoryAsync(cwd)
      if (!normalizedPath) continue

      const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
      const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
      const metadataModifiedAt = [recordTimestamp, payloadTimestamp, fileStat.mtimeMs]
        .find((value) => !Number.isNaN(value)) ?? fileStat.mtimeMs

      yield {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: updatedAtById.get(sessionId) ?? metadataModifiedAt,
      }
    }
  }
}

export const DEFAULT_PROJECT_DISCOVERY_ADAPTERS: ProjectDiscoveryAdapter[] = [
  new ClaudeProjectDiscoveryAdapter(),
  new CodexProjectDiscoveryAdapter(),
]

export function discoverProjects(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS
): DiscoveredProject[] {
  const mergedProjects = mergeDiscoveredProjects(
    adapters.flatMap((adapter) => adapter.scan(homeDir).map(({ provider: _provider, ...project }) => project))
  )

  return mergedProjects
}

export async function discoverProjectsIncrementally(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS,
  options: IncrementalProjectDiscoveryOptions = {}
): Promise<DiscoveredProject[]> {
  let projects = mergeDiscoveredProjects(options.initialProjects ?? [])
  let pendingUpdates = 0
  const updateBatchSize = Math.max(1, options.updateBatchSize ?? DISCOVERY_UPDATE_BATCH_SIZE)

  const publish = async (force = false, complete = false) => {
    if (!options.onUpdate || (!force && pendingUpdates < updateBatchSize)) {
      return
    }
    pendingUpdates = 0
    await options.onUpdate(projects.map((project) => ({ ...project })), { complete })
  }

  // Saved StillOn projects are available before any provider history is read.
  await publish(true)

  for (const adapter of adapters) {
    options.signal?.throwIfAborted()
    const discovered = adapter.scanIncrementally
      ? adapter.scanIncrementally(homeDir, { signal: options.signal })
      : adapter.scan(homeDir)

    for await (const { provider: _provider, ...project } of discovered) {
      options.signal?.throwIfAborted()
      const nextProjects = mergeDiscoveredProjects([...projects, project])
      const changed = nextProjects.length !== projects.length
        || nextProjects.some((entry, index) => (
          entry.localPath !== projects[index]?.localPath
          || entry.title !== projects[index]?.title
          || entry.modifiedAt !== projects[index]?.modifiedAt
        ))
      if (!changed) continue

      projects = nextProjects
      pendingUpdates += 1
      await publish()
    }
  }

  await publish(true, true)
  return projects
}
