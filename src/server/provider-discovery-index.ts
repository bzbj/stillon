import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import type { DiscoveredProject, ProviderDiscoveredProject } from "./discovery"

// Durable metadata-only reuse for provider discovery. Provider transcript files
// remain authoritative; every read/write failure degrades to a cold scan.
const PROVIDER_DISCOVERY_INDEX_SCHEMA_VERSION = 1
const MAX_CACHE_FILE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_ENTRIES = 50_000
const MAX_NESTED_ITEMS = 100_000
const MAX_PATH_LENGTH = 32_768
const MAX_TITLE_LENGTH = 4_096
const MAX_SESSION_ID_LENGTH = 4_096
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export const PROVIDER_DISCOVERY_INDEX_FILE_NAME = "provider-discovery-index.json"
export const PROVIDER_DISCOVERY_PARSER_VERSIONS = {
  "claude-project": 1,
  "codex-config": 1,
  "codex-index": 1,
  "codex-session": 1,
} as const

export interface ProviderSourceFingerprint {
  sizeBytes: number
  mtimeMs: number
}

export function canonicalizeProviderSourcePath(sourcePath: string) {
  const resolved = path.resolve(sourcePath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

interface ProviderDiscoveryIndexEntryBase extends ProviderSourceFingerprint {
  provider: AgentProvider
  sourcePath: string
  parserVersion: number
}

export interface ClaudeProjectIndexEntry extends ProviderDiscoveryIndexEntryBase {
  provider: "claude"
  kind: "claude-project"
  project: DiscoveredProject | null
}

export interface CodexSessionIndexEntry extends ProviderDiscoveryIndexEntryBase {
  provider: "codex"
  kind: "codex-session"
  session: {
    id: string
    cwd: string
    metadataModifiedAt: number
  } | null
  project: DiscoveredProject | null
}

export interface CodexSessionListIndexEntry extends ProviderDiscoveryIndexEntryBase {
  provider: "codex"
  kind: "codex-index"
  updatedAtById: Array<[string, number]>
}

export interface CodexConfigIndexEntry extends ProviderDiscoveryIndexEntryBase {
  provider: "codex"
  kind: "codex-config"
  configuredProjects: Array<[string, number]>
  projects: DiscoveredProject[]
}

export type ProviderDiscoveryIndexEntry =
  | ClaudeProjectIndexEntry
  | CodexSessionIndexEntry
  | CodexSessionListIndexEntry
  | CodexConfigIndexEntry

type ProviderDiscoveryEntryKind = ProviderDiscoveryIndexEntry["kind"]

interface PersistedProviderDiscoveryIndex {
  schemaVersion: number
  platform: NodeJS.Platform
  sourceRoot: string
  entries: ProviderDiscoveryIndexEntry[]
}

function entryKey(provider: AgentProvider, sourcePath: string) {
  return `${provider}\u0000${canonicalizeProviderSourcePath(sourcePath)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\u0000")
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isSourceSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parseProject(value: unknown): DiscoveredProject | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, ["localPath", "title", "modifiedAt"])) {
    return undefined
  }
  if (
    !isBoundedString(value.localPath, MAX_PATH_LENGTH)
    || !path.isAbsolute(value.localPath)
    || typeof value.title !== "string"
    || value.title.length > MAX_TITLE_LENGTH
    || !isFiniteTimestamp(value.modifiedAt)
  ) {
    return undefined
  }
  return {
    localPath: value.localPath,
    title: value.title,
    modifiedAt: value.modifiedAt,
  }
}

function parsePairs(
  value: unknown,
  options: { firstMaxLength: number; budget: { remaining: number } },
): Array<[string, number]> | null {
  if (!Array.isArray(value) || value.length > options.budget.remaining) {
    return null
  }
  options.budget.remaining -= value.length
  const pairs: Array<[string, number]> = []
  const keys = new Set<string>()
  for (const item of value) {
    if (
      !Array.isArray(item)
      || item.length !== 2
      || !isBoundedString(item[0], options.firstMaxLength)
      || !isFiniteTimestamp(item[1])
    ) {
      return null
    }
    if (keys.has(item[0])) return null
    keys.add(item[0])
    pairs.push([item[0], item[1]])
  }
  return pairs
}

function parseProjects(
  value: unknown,
  budget: { remaining: number },
): DiscoveredProject[] | null {
  if (!Array.isArray(value) || value.length > budget.remaining) {
    return null
  }
  budget.remaining -= value.length
  const projects: DiscoveredProject[] = []
  for (const item of value) {
    const project = parseProject(item)
    if (!project) return null
    projects.push(project)
  }
  return projects
}

function parseEntryBase(
  value: Record<string, unknown>,
  kind: ProviderDiscoveryEntryKind,
): ProviderDiscoveryIndexEntryBase | null {
  const expectedProvider = kind === "claude-project" ? "claude" : "codex"
  if (
    value.provider !== expectedProvider
    || value.kind !== kind
    || !isBoundedString(value.sourcePath, MAX_PATH_LENGTH)
    || !path.isAbsolute(value.sourcePath)
    || value.sourcePath !== canonicalizeProviderSourcePath(value.sourcePath)
    || !isSourceSize(value.sizeBytes)
    || !isFiniteTimestamp(value.mtimeMs)
    || value.parserVersion !== PROVIDER_DISCOVERY_PARSER_VERSIONS[kind]
  ) {
    return null
  }
  return {
    provider: expectedProvider,
    sourcePath: value.sourcePath,
    sizeBytes: value.sizeBytes,
    mtimeMs: value.mtimeMs,
    parserVersion: value.parserVersion,
  }
}

function parseEntry(
  value: unknown,
  budget: { remaining: number },
): ProviderDiscoveryIndexEntry | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null

  if (value.kind === "claude-project") {
    if (!hasExactKeys(value, [
      "provider",
      "kind",
      "sourcePath",
      "sizeBytes",
      "mtimeMs",
      "parserVersion",
      "project",
    ])) {
      return null
    }
    const base = parseEntryBase(value, value.kind)
    const project = parseProject(value.project)
    if (!base || project === undefined) return null
    return { ...base, provider: "claude", kind: value.kind, project }
  }

  if (value.kind === "codex-session") {
    if (!hasExactKeys(value, [
      "provider",
      "kind",
      "sourcePath",
      "sizeBytes",
      "mtimeMs",
      "parserVersion",
      "session",
      "project",
    ])) {
      return null
    }
    const base = parseEntryBase(value, value.kind)
    const project = parseProject(value.project)
    if (!base || project === undefined) return null

    let session: CodexSessionIndexEntry["session"] = null
    if (value.session !== null) {
      if (
        !isRecord(value.session)
        || !hasExactKeys(value.session, ["id", "cwd", "metadataModifiedAt"])
        || !isBoundedString(value.session.id, MAX_SESSION_ID_LENGTH)
        || !isBoundedString(value.session.cwd, MAX_PATH_LENGTH)
        || !path.isAbsolute(value.session.cwd)
        || !isFiniteTimestamp(value.session.metadataModifiedAt)
      ) {
        return null
      }
      session = {
        id: value.session.id,
        cwd: value.session.cwd,
        metadataModifiedAt: value.session.metadataModifiedAt,
      }
    }
    return {
      ...base,
      provider: "codex",
      kind: value.kind,
      session,
      project,
    }
  }

  if (value.kind === "codex-index") {
    if (!hasExactKeys(value, [
      "provider",
      "kind",
      "sourcePath",
      "sizeBytes",
      "mtimeMs",
      "parserVersion",
      "updatedAtById",
    ])) {
      return null
    }
    const base = parseEntryBase(value, value.kind)
    const updatedAtById = parsePairs(value.updatedAtById, {
      firstMaxLength: MAX_SESSION_ID_LENGTH,
      budget,
    })
    if (!base || !updatedAtById) return null
    return {
      ...base,
      provider: "codex",
      kind: value.kind,
      updatedAtById,
    }
  }

  if (value.kind === "codex-config") {
    if (!hasExactKeys(value, [
      "provider",
      "kind",
      "sourcePath",
      "sizeBytes",
      "mtimeMs",
      "parserVersion",
      "configuredProjects",
      "projects",
    ])) {
      return null
    }
    const base = parseEntryBase(value, value.kind)
    const configuredProjects = parsePairs(value.configuredProjects, {
      firstMaxLength: MAX_PATH_LENGTH,
      budget,
    })
    const projects = parseProjects(value.projects, budget)
    if (!base || !configuredProjects || !projects) return null
    if (configuredProjects.some(([configuredPath]) => !path.isAbsolute(configuredPath))) {
      return null
    }
    return {
      ...base,
      provider: "codex",
      kind: value.kind,
      configuredProjects,
      projects,
    }
  }

  return null
}

function isEntryWithinSourceRoot(
  entry: ProviderDiscoveryIndexEntry,
  sourceRoot: string,
) {
  const codexRoot = canonicalizeProviderSourcePath(path.join(sourceRoot, ".codex"))
  if (entry.kind === "codex-index") {
    return entry.sourcePath === canonicalizeProviderSourcePath(
      path.join(codexRoot, "session_index.jsonl"),
    )
  }
  if (entry.kind === "codex-config") {
    return entry.sourcePath === canonicalizeProviderSourcePath(
      path.join(codexRoot, "config.toml"),
    )
  }
  const expectedRoot = entry.kind === "codex-session"
    ? canonicalizeProviderSourcePath(path.join(codexRoot, "sessions"))
    : canonicalizeProviderSourcePath(path.join(sourceRoot, ".claude", "projects"))
  const relative = path.relative(expectedRoot, entry.sourcePath)
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function parsePersistedIndex(
  value: unknown,
  sourceRoot: string,
): ProviderDiscoveryIndexEntry[] | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "platform", "sourceRoot", "entries"])
    || value.schemaVersion !== PROVIDER_DISCOVERY_INDEX_SCHEMA_VERSION
    || value.platform !== process.platform
    || value.sourceRoot !== sourceRoot
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_CACHE_ENTRIES
  ) {
    return null
  }

  const entries: ProviderDiscoveryIndexEntry[] = []
  const keys = new Set<string>()
  const budget = { remaining: MAX_NESTED_ITEMS }
  for (const rawEntry of value.entries) {
    const entry = parseEntry(rawEntry, budget)
    if (!entry || !isEntryWithinSourceRoot(entry, sourceRoot)) return null
    const key = entryKey(entry.provider, entry.sourcePath)
    if (keys.has(key)) return null
    keys.add(key)
    entries.push(entry)
  }
  return entries
}

function cloneProject(project: DiscoveredProject): DiscoveredProject {
  return { ...project }
}

function cloneEntry<T extends ProviderDiscoveryIndexEntry>(entry: T): T {
  if (entry.kind === "claude-project") {
    return {
      ...entry,
      project: entry.project ? cloneProject(entry.project) : null,
    } as T
  }
  if (entry.kind === "codex-session") {
    return {
      ...entry,
      session: entry.session ? { ...entry.session } : null,
      project: entry.project ? cloneProject(entry.project) : null,
    } as T
  }
  if (entry.kind === "codex-index") {
    return {
      ...entry,
      updatedAtById: entry.updatedAtById.map(([id, modifiedAt]) => [id, modifiedAt]),
    } as T
  }
  return {
    ...entry,
    configuredProjects: entry.configuredProjects.map(([localPath, modifiedAt]) => [localPath, modifiedAt]),
    projects: entry.projects.map(cloneProject),
  } as T
}

function isMatchingFingerprint(
  entry: ProviderDiscoveryIndexEntry,
  fingerprint: ProviderSourceFingerprint,
) {
  return entry.sizeBytes === fingerprint.sizeBytes && entry.mtimeMs === fingerprint.mtimeMs
}

function areEntriesEqual(
  current: ReadonlyMap<string, ProviderDiscoveryIndexEntry>,
  next: ReadonlyMap<string, ProviderDiscoveryIndexEntry>,
) {
  if (current.size !== next.size) return false
  for (const [key, currentEntry] of current) {
    const nextEntry = next.get(key)
    if (!nextEntry || JSON.stringify(currentEntry) !== JSON.stringify(nextEntry)) {
      return false
    }
  }
  return true
}

function tempFilePrefix(filePath: string) {
  return `.${path.basename(filePath)}.tmp-`
}

async function sweepOrphanedTempFiles(filePath: string) {
  const directory = path.dirname(filePath)
  const prefix = tempFilePrefix(filePath)
  try {
    const names = await readdir(directory)
    await Promise.all(names
      .filter((name) => name.startsWith(prefix))
      .map((name) => rm(path.join(directory, name), { force: true }).catch(() => {})))
  } catch {
    // A missing or unreadable cache directory has nothing safe to sweep.
  }
}

async function discardInvalidCache(filePath: string) {
  await rm(filePath, { force: true }).catch(() => {})
}

export function getProviderDiscoveryIndexPath(dataDir: string) {
  return path.join(dataDir, "cache", PROVIDER_DISCOVERY_INDEX_FILE_NAME)
}

export class ProviderDiscoveryIndex {
  readonly sourceRoot: string
  readonly filePath: string

  private readonly entries = new Map<string, ProviderDiscoveryIndexEntry>()
  private readonly providerRevisions = new Map<AgentProvider, number>()
  private writeChain: Promise<boolean> = Promise.resolve(true)
  private mutationVersion = 0
  private persistedVersion = 0

  private constructor(filePath: string, sourceRoot: string) {
    this.filePath = filePath
    this.sourceRoot = sourceRoot
  }

  static async load(options: {
    filePath: string
    sourceRoot?: string
  }): Promise<ProviderDiscoveryIndex> {
    const sourceRoot = canonicalizeProviderSourcePath(options.sourceRoot ?? homedir())
    const index = new ProviderDiscoveryIndex(options.filePath, sourceRoot)
    await sweepOrphanedTempFiles(options.filePath)

    let fileSize: number
    try {
      fileSize = (await stat(options.filePath)).size
    } catch {
      return index
    }
    if (fileSize > MAX_CACHE_FILE_BYTES) {
      await discardInvalidCache(options.filePath)
      return index
    }

    let raw: string
    try {
      raw = await readFile(options.filePath, "utf8")
    } catch {
      return index
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CACHE_FILE_BYTES) {
      await discardInvalidCache(options.filePath)
      return index
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await discardInvalidCache(options.filePath)
      return index
    }

    const entries = parsePersistedIndex(parsed, sourceRoot)
    if (!entries) {
      await discardInvalidCache(options.filePath)
      return index
    }
    for (const entry of entries) {
      index.entries.set(entryKey(entry.provider, entry.sourcePath), entry)
    }
    return index
  }

  listProjects(providers?: ReadonlySet<AgentProvider>): ProviderDiscoveredProject[] {
    const projects: ProviderDiscoveredProject[] = []
    for (const entry of this.entries.values()) {
      if (providers && !providers.has(entry.provider)) continue
      if (entry.kind === "claude-project" || entry.kind === "codex-session") {
        if (entry.project) {
          projects.push({ provider: entry.provider, ...cloneProject(entry.project) })
        }
        continue
      }
      if (entry.kind === "codex-config") {
        projects.push(...entry.projects.map((project) => ({
          provider: entry.provider,
          ...cloneProject(project),
        })))
      }
    }
    return projects
  }

  getMatchingEntry<K extends ProviderDiscoveryEntryKind>(
    provider: AgentProvider,
    sourcePath: string,
    fingerprint: ProviderSourceFingerprint,
    kind: K,
  ): Extract<ProviderDiscoveryIndexEntry, { kind: K }> | null {
    const entry = this.entries.get(entryKey(provider, sourcePath))
    if (
      !entry
      || entry.kind !== kind
      || entry.parserVersion !== PROVIDER_DISCOVERY_PARSER_VERSIONS[kind]
      || !isMatchingFingerprint(entry, fingerprint)
    ) {
      return null
    }
    return cloneEntry(entry as Extract<ProviderDiscoveryIndexEntry, { kind: K }>)
  }

  getProviderRevision(provider: AgentProvider) {
    return this.providerRevisions.get(provider) ?? 0
  }

  replaceProviderEntries(
    provider: AgentProvider,
    nextEntries: Iterable<ProviderDiscoveryIndexEntry>,
  ) {
    const replacementEntries = [...nextEntries]
    if (replacementEntries.some((entry) => entry.provider !== provider)) {
      throw new Error(`Discovery index provider mismatch: expected ${provider}`)
    }
    const prospectiveEntries = [
      ...[...this.entries.values()].filter((entry) => entry.provider !== provider),
      ...replacementEntries,
    ]
    if (prospectiveEntries.length > MAX_CACHE_ENTRIES) {
      throw new Error("Too many provider discovery index entries")
    }

    const validatedEntries: ProviderDiscoveryIndexEntry[] = []
    const keys = new Set<string>()
    const budget = { remaining: MAX_NESTED_ITEMS }
    for (const entry of prospectiveEntries) {
      const parsed = parseEntry(entry, budget)
      if (!parsed || !isEntryWithinSourceRoot(parsed, this.sourceRoot)) {
        throw new Error("Invalid provider discovery index entry")
      }
      const key = entryKey(parsed.provider, parsed.sourcePath)
      if (keys.has(key)) {
        throw new Error(`Duplicate ${provider} discovery source path`)
      }
      keys.add(key)
      validatedEntries.push(parsed)
    }

    const nextMap = new Map<string, ProviderDiscoveryIndexEntry>()
    for (const entry of validatedEntries) {
      nextMap.set(entryKey(entry.provider, entry.sourcePath), entry)
    }
    if (!areEntriesEqual(this.entries, nextMap)) {
      this.entries.clear()
      for (const [key, entry] of nextMap) {
        this.entries.set(key, entry)
      }
      this.mutationVersion += 1
    }
    this.providerRevisions.set(provider, this.getProviderRevision(provider) + 1)
  }

  persist(): Promise<boolean> {
    if (this.mutationVersion === this.persistedVersion) {
      return Promise.resolve(true)
    }
    const snapshotVersion = this.mutationVersion
    const entries = [...this.entries.values()]
      .map((entry) => cloneEntry(entry))
      .sort((left, right) => (
        left.provider.localeCompare(right.provider)
        || left.sourcePath.localeCompare(right.sourcePath)
      ))
    const file: PersistedProviderDiscoveryIndex = {
      schemaVersion: PROVIDER_DISCOVERY_INDEX_SCHEMA_VERSION,
      platform: process.platform,
      sourceRoot: this.sourceRoot,
      entries,
    }
    const payload = `${JSON.stringify(file)}\n`
    if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_FILE_BYTES) {
      return Promise.resolve(false)
    }

    this.writeChain = this.writeChain.then(async () => {
      const directory = path.dirname(this.filePath)
      const tempPath = path.join(
        directory,
        `${tempFilePrefix(this.filePath)}${process.pid}-${randomUUID()}`,
      )
      try {
        await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
        await writeFile(tempPath, payload, {
          encoding: "utf8",
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        })
        await rename(tempPath, this.filePath)
        this.persistedVersion = Math.max(this.persistedVersion, snapshotVersion)
        return true
      } catch {
        return false
      } finally {
        await rm(tempPath, { force: true }).catch(() => {})
      }
    })
    return this.writeChain
  }
}
