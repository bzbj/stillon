import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { open, readFile, readdir, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"
import {
  canonicalizeProviderSourcePath,
  PROVIDER_DISCOVERY_PARSER_VERSIONS,
  type CodexConfigIndexEntry,
  type CodexSessionIndexEntry,
  type CodexSessionListIndexEntry,
  type ClaudeProjectIndexEntry,
  type ProviderDiscoveryIndex,
  type ProviderDiscoveryIndexEntry,
  type ProviderSourceFingerprint,
} from "./provider-discovery-index"

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
    options?: ProjectDiscoveryScanOptions
  ): AsyncIterable<ProviderDiscoveredProject>
}

export interface ProjectDiscoveryStats {
  sourcesInspected: number
  sourceBytesInspected: number
  cacheHits: number
  cacheMisses: number
  sourcesParsed: number
}

export function createProjectDiscoveryStats(): ProjectDiscoveryStats {
  return {
    sourcesInspected: 0,
    sourceBytesInspected: 0,
    cacheHits: 0,
    cacheMisses: 0,
    sourcesParsed: 0,
  }
}

export interface ProjectDiscoveryScanOptions {
  signal?: AbortSignal
  cache?: ProviderDiscoveryIndex
  stats?: ProjectDiscoveryStats
}

export interface IncrementalProjectDiscoveryOptions {
  initialProjects?: Iterable<DiscoveredProject>
  signal?: AbortSignal
  onUpdate?: (
    projects: DiscoveredProject[],
    progress: { complete: boolean }
  ) => void | Promise<void>
  updateBatchSize?: number
  cache?: ProviderDiscoveryIndex
  stats?: ProjectDiscoveryStats
}

interface InspectedProviderSource extends ProviderSourceFingerprint {
  sourcePath: string
}

async function inspectProviderSource(
  sourcePath: string,
  expectedType: "file" | "directory",
  stats?: ProjectDiscoveryStats,
): Promise<InspectedProviderSource | null> {
  let sourceStats
  try {
    sourceStats = await stat(sourcePath)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  if (
    (expectedType === "file" && !sourceStats.isFile())
    || (expectedType === "directory" && !sourceStats.isDirectory())
  ) {
    return null
  }
  if (stats) {
    stats.sourcesInspected += 1
    stats.sourceBytesInspected += sourceStats.size
  }
  return {
    sourcePath: canonicalizeProviderSourcePath(sourcePath),
    sizeBytes: sourceStats.size,
    mtimeMs: sourceStats.mtimeMs,
  }
}

function noteCacheResult(stats: ProjectDiscoveryStats | undefined, hit: boolean) {
  if (!stats) return
  if (hit) {
    stats.cacheHits += 1
  } else {
    stats.cacheMisses += 1
    stats.sourcesParsed += 1
  }
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
    options: ProjectDiscoveryScanOptions = {}
  ): AsyncIterable<ProviderDiscoveredProject> {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    let directoryEntries: Dirent[]
    try {
      directoryEntries = await readdir(projectsDir, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) {
        options.cache?.replaceProviderEntries(this.provider, [])
        return
      }
      throw error
    }

    const entries: Array<{
      entry: Dirent
      source: InspectedProviderSource
    }> = []
    for (const entry of directoryEntries) {
      if (!entry.isDirectory()) continue
      const source = await inspectProviderSource(
        path.join(projectsDir, entry.name),
        "directory",
        options.stats,
      )
      if (source) entries.push({ entry, source })
    }
    entries.sort((left, right) => right.source.mtimeMs - left.source.mtimeMs)

    const nextCacheEntries: ClaudeProjectIndexEntry[] = []
    for (const { entry, source } of entries) {
      options.signal?.throwIfAborted()
      const cached = options.cache?.getMatchingEntry(
        this.provider,
        source.sourcePath,
        source,
        "claude-project",
      )
      let project: DiscoveredProject | null = null
      let reused = false
      if (cached?.project) {
        const normalizedPath = await normalizeExistingDirectoryAsync(cached.project.localPath)
        if (normalizedPath) {
          reused = true
          project = {
            localPath: normalizedPath,
            title: path.basename(normalizedPath) || normalizedPath,
            modifiedAt: source.mtimeMs,
          }
        }
      }

      noteCacheResult(options.stats, reused)
      if (!reused) {
        const resolvedPath = resolveEncodedClaudePath(entry.name)
        const normalizedPath = resolvedPath
          ? await normalizeExistingDirectoryAsync(resolvedPath)
          : null
        if (normalizedPath) {
          project = {
            localPath: normalizedPath,
            title: path.basename(normalizedPath) || normalizedPath,
            modifiedAt: source.mtimeMs,
          }
        }
      }

      nextCacheEntries.push({
        provider: this.provider,
        kind: "claude-project",
        sourcePath: source.sourcePath,
        sizeBytes: source.sizeBytes,
        mtimeMs: source.mtimeMs,
        parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["claude-project"],
        project,
      })
      if (project) {
        yield { provider: this.provider, ...project }
      }
    }
    options.cache?.replaceProviderEntries(this.provider, nextCacheEntries)
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

function parseCodexSessionIndexContent(content: string) {
  const updatedAtById = new Map<string, number>()
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

function readCodexSessionIndex(indexPath: string) {
  if (!existsSync(indexPath)) {
    return new Map<string, number>()
  }
  return parseCodexSessionIndexContent(readFileSync(indexPath, "utf8"))
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

function parseCodexConfiguredProjectsContent(content: string, configMtime: number) {
  const projects = new Map<string, number>()
  for (const line of content.split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

function readCodexConfiguredProjects(configPath: string) {
  if (!existsSync(configPath)) {
    return new Map<string, number>()
  }
  const configMtime = statSync(configPath).mtimeMs
  return parseCodexConfiguredProjectsContent(readFileSync(configPath, "utf8"), configMtime)
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

async function readCodexSessionListCached(
  indexPath: string,
  options: ProjectDiscoveryScanOptions,
  nextEntries: ProviderDiscoveryIndexEntry[],
) {
  const source = await inspectProviderSource(indexPath, "file", options.stats)
  if (!source) return new Map<string, number>()

  const cached = options.cache?.getMatchingEntry(
    "codex",
    source.sourcePath,
    source,
    "codex-index",
  )
  noteCacheResult(options.stats, Boolean(cached))
  let updatedAtById: Map<string, number>
  if (cached) {
    updatedAtById = new Map(cached.updatedAtById)
    nextEntries.push(cached)
    return updatedAtById
  }

  let content
  try {
    content = await readFile(source.sourcePath, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return new Map<string, number>()
    throw error
  }
  updatedAtById = parseCodexSessionIndexContent(content)
  const entry: CodexSessionListIndexEntry = {
    provider: "codex",
    kind: "codex-index",
    sourcePath: source.sourcePath,
    sizeBytes: source.sizeBytes,
    mtimeMs: source.mtimeMs,
    parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["codex-index"],
    updatedAtById: [...updatedAtById.entries()],
  }
  nextEntries.push(entry)
  return updatedAtById
}

async function readCodexConfigCached(
  configPath: string,
  options: ProjectDiscoveryScanOptions,
) {
  const source = await inspectProviderSource(configPath, "file", options.stats)
  if (!source) return null

  const cached = options.cache?.getMatchingEntry(
    "codex",
    source.sourcePath,
    source,
    "codex-config",
  )
  noteCacheResult(options.stats, Boolean(cached))
  if (cached) {
    return {
      source,
      configuredProjects: new Map(cached.configuredProjects),
    }
  }

  let content
  try {
    content = await readFile(source.sourcePath, "utf8")
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  return {
    source,
    configuredProjects: parseCodexConfiguredProjectsContent(content, source.mtimeMs),
  }
}

function parseCodexSessionMetadata(
  firstLine: string | null,
  fileModifiedAt: number,
): CodexSessionIndexEntry["session"] {
  if (!firstLine?.trim()) return null
  const record = parseJsonRecord(firstLine)
  if (!record || record.type !== "session_meta") return null
  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null

  const payloadRecord = payload as Record<string, unknown>
  const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
  const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
  if (!sessionId || !cwd || !path.isAbsolute(cwd)) return null

  const recordTimestamp = typeof record.timestamp === "string"
    ? Date.parse(record.timestamp)
    : Number.NaN
  const payloadTimestamp = typeof payloadRecord.timestamp === "string"
    ? Date.parse(payloadRecord.timestamp)
    : Number.NaN
  const metadataModifiedAt = [recordTimestamp, payloadTimestamp, fileModifiedAt]
    .find((value) => !Number.isNaN(value)) ?? fileModifiedAt
  return { id: sessionId, cwd, metadataModifiedAt }
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
    options: ProjectDiscoveryScanOptions = {}
  ): AsyncIterable<ProviderDiscoveredProject> {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const nextCacheEntries: ProviderDiscoveryIndexEntry[] = []
    const [updatedAtById, cachedConfig] = await Promise.all([
      readCodexSessionListCached(indexPath, options, nextCacheEntries),
      readCodexConfigCached(configPath, options),
    ])
    const normalizedProjectPaths = new Map<string, Promise<string | null>>()
    const normalizeProjectPath = (localPath: string) => {
      let pending = normalizedProjectPaths.get(localPath)
      if (!pending) {
        pending = normalizeExistingDirectoryAsync(localPath)
        normalizedProjectPaths.set(localPath, pending)
      }
      return pending
    }

    if (cachedConfig) {
      const configProjects: DiscoveredProject[] = []
      for (const [configuredPath, modifiedAt] of [...cachedConfig.configuredProjects.entries()]
        .sort((left, right) => right[1] - left[1])) {
        options.signal?.throwIfAborted()
        if (!path.isAbsolute(configuredPath)) continue
        const normalizedPath = await normalizeProjectPath(configuredPath)
        if (!normalizedPath) continue

        const project = {
          localPath: normalizedPath,
          title: path.basename(normalizedPath) || normalizedPath,
          modifiedAt,
        }
        configProjects.push(project)
        yield { provider: this.provider, ...project }
      }
      const configEntry: CodexConfigIndexEntry = {
        provider: this.provider,
        kind: "codex-config",
        sourcePath: cachedConfig.source.sourcePath,
        sizeBytes: cachedConfig.source.sizeBytes,
        mtimeMs: cachedConfig.source.mtimeMs,
        parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["codex-config"],
        configuredProjects: [...cachedConfig.configuredProjects.entries()],
        projects: configProjects,
      }
      nextCacheEntries.push(configEntry)
    }

    for await (const sessionFile of collectCodexSessionFilesIncrementally(sessionsDir, options.signal)) {
      options.signal?.throwIfAborted()
      const source = await inspectProviderSource(sessionFile, "file", options.stats)
      if (!source) continue
      const cached = options.cache?.getMatchingEntry(
        this.provider,
        source.sourcePath,
        source,
        "codex-session",
      )
      noteCacheResult(options.stats, Boolean(cached))

      let session = cached?.session ?? null
      if (!cached) {
        let firstLine
        try {
          firstLine = await readFirstLine(source.sourcePath, options.signal)
        } catch (error) {
          if (isMissingPathError(error)) continue
          throw error
        }
        session = parseCodexSessionMetadata(firstLine, source.mtimeMs)
      }

      let project: DiscoveredProject | null = null
      if (session) {
        const normalizedPath = await normalizeProjectPath(session.cwd)
        if (normalizedPath) {
          project = {
            localPath: normalizedPath,
            title: path.basename(normalizedPath) || normalizedPath,
            modifiedAt: updatedAtById.get(session.id) ?? session.metadataModifiedAt,
          }
        }
      }
      const entry: CodexSessionIndexEntry = {
        provider: this.provider,
        kind: "codex-session",
        sourcePath: source.sourcePath,
        sizeBytes: source.sizeBytes,
        mtimeMs: source.mtimeMs,
        parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["codex-session"],
        session,
        project,
      }
      nextCacheEntries.push(entry)
      if (project) {
        yield { provider: this.provider, ...project }
      }
    }
    options.cache?.replaceProviderEntries(this.provider, nextCacheEntries)
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
  const providers = new Set(adapters.map((adapter) => adapter.provider))
  const cachedProjects = options.cache?.listProjects(providers)
    .map(({ provider: _provider, ...project }) => project) ?? []
  let authoritativeProjects = mergeDiscoveredProjects(options.initialProjects ?? [])
  let projects = mergeDiscoveredProjects([...cachedProjects, ...authoritativeProjects])
  let pendingUpdates = 0
  const updateBatchSize = Math.max(1, options.updateBatchSize ?? DISCOVERY_UPDATE_BATCH_SIZE)

  const publish = async (force = false, complete = false) => {
    if (!options.onUpdate || (!force && pendingUpdates < updateBatchSize)) {
      return
    }
    pendingUpdates = 0
    await options.onUpdate(projects.map((project) => ({ ...project })), { complete })
  }

  // Saved StillOn projects and the last-known provider index are available
  // before any provider source is opened. The latter stays visible until the
  // complete scan replaces it with the authoritative set.
  await publish(true)

  for (const adapter of adapters) {
    options.signal?.throwIfAborted()
    const cacheRevision = options.cache?.getProviderRevision(adapter.provider)
    const discovered = adapter.scanIncrementally
      ? adapter.scanIncrementally(homeDir, {
        signal: options.signal,
        cache: options.cache,
        stats: options.stats,
      })
      : adapter.scan(homeDir)

    for await (const { provider: _provider, ...project } of discovered) {
      options.signal?.throwIfAborted()
      authoritativeProjects = mergeDiscoveredProjects([...authoritativeProjects, project])
      const nextProjects = mergeDiscoveredProjects([...cachedProjects, ...authoritativeProjects])
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
    options.signal?.throwIfAborted()
    if (
      options.cache
      && options.cache.getProviderRevision(adapter.provider) === cacheRevision
    ) {
      // An adapter without cache integration still authoritatively scanned its
      // provider, so stale persisted entries for that provider must not survive.
      options.cache.replaceProviderEntries(adapter.provider, [])
    }
  }

  options.signal?.throwIfAborted()
  projects = authoritativeProjects
  await publish(true, true)
  await options.cache?.persist()
  return projects
}
