import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ClaudeProjectDiscoveryAdapter,
  CodexProjectDiscoveryAdapter,
  createProjectDiscoveryStats,
  discoverProjectsIncrementally,
  type ProviderDiscoveredProject,
} from "./discovery"
import {
  getProviderDiscoveryIndexPath,
  ProviderDiscoveryIndex,
} from "./provider-discovery-index"

const tempDirs: string[] = []

function makeFixture() {
  const homeDir = mkdtempSync(path.join(tmpdir(), "stillon-provider-discovery-"))
  tempDirs.push(homeDir)
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "29")
  const cachePath = getProviderDiscoveryIndexPath(path.join(homeDir, ".stillon", "data"))
  mkdirSync(sessionsDir, { recursive: true })
  return { homeDir, sessionsDir, cachePath }
}

function writeSession(options: {
  filePath: string
  projectPath: string
  sessionId?: string
  timestamp?: string
}) {
  mkdirSync(options.projectPath, { recursive: true })
  writeFileSync(options.filePath, [
    JSON.stringify({
      timestamp: options.timestamp ?? "2026-07-29T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: options.sessionId ?? "synthetic-session",
        cwd: options.projectPath,
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { synthetic: true },
    }),
  ].join("\n"))
}

async function collectCodexProjects(
  homeDir: string,
  cache: ProviderDiscoveryIndex,
  stats = createProjectDiscoveryStats(),
) {
  const projects: ProviderDiscoveredProject[] = []
  const adapter = new CodexProjectDiscoveryAdapter()
  for await (const project of adapter.scanIncrementally(homeDir, { cache, stats })) {
    projects.push(project)
  }
  return { projects, stats }
}

async function collectClaudeProjects(
  homeDir: string,
  cache: ProviderDiscoveryIndex,
  stats = createProjectDiscoveryStats(),
) {
  const projects: ProviderDiscoveredProject[] = []
  const adapter = new ClaudeProjectDiscoveryAdapter()
  for await (const project of adapter.scanIncrementally(homeDir, { cache, stats })) {
    projects.push(project)
  }
  return { projects, stats }
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("persistent provider discovery", () => {
  test("publishes a warm cached project before scanning and does not reparse an unchanged transcript", async () => {
    const { homeDir, sessionsDir, cachePath } = makeFixture()
    const projectPath = path.join(homeDir, "workspace", "warm-project")
    writeSession({
      filePath: path.join(sessionsDir, "warm-session.jsonl"),
      projectPath,
    })

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const cold = await collectCodexProjects(homeDir, coldCache)
    expect(cold.projects.map((project) => project.localPath)).toEqual([projectPath])
    expect(cold.stats).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
    expect(await coldCache.persist()).toBe(true)

    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const updates: Array<{
      complete: boolean
      paths: string[]
    }> = []
    const warmStats = createProjectDiscoveryStats()
    const projects = await discoverProjectsIncrementally(
      homeDir,
      [new CodexProjectDiscoveryAdapter()],
      {
        cache: warmCache,
        stats: warmStats,
        updateBatchSize: 1,
        onUpdate: (nextProjects, progress) => {
          updates.push({
            complete: progress.complete,
            paths: nextProjects.map((project) => project.localPath),
          })
        },
      },
    )

    expect(updates[0]).toEqual({ complete: false, paths: [projectPath] })
    expect(updates.at(-1)).toEqual({ complete: true, paths: [projectPath] })
    expect(projects.map((project) => project.localPath)).toEqual([projectPath])
    expect(warmStats).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      sourcesParsed: 0,
    })
  })

  test("invalidates and reparses a modified transcript", async () => {
    const { homeDir, sessionsDir, cachePath } = makeFixture()
    const sessionPath = path.join(sessionsDir, "modified-session.jsonl")
    const firstProjectPath = path.join(homeDir, "workspace", "first-project")
    const secondProjectPath = path.join(homeDir, "workspace", "second-project-with-new-size")
    writeSession({ filePath: sessionPath, projectPath: firstProjectPath })

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    await collectCodexProjects(homeDir, coldCache)
    expect(await coldCache.persist()).toBe(true)

    writeSession({
      filePath: sessionPath,
      projectPath: secondProjectPath,
      timestamp: "2026-07-29T02:00:00.000Z",
    })
    const changedTime = new Date("2026-07-29T02:00:01.000Z")
    utimesSync(sessionPath, changedTime, changedTime)

    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const changed = await collectCodexProjects(homeDir, warmCache)
    expect(changed.projects.map((project) => project.localPath)).toEqual([secondProjectPath])
    expect(changed.stats).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
  })

  test("parses a new transcript while reusing unchanged cached sessions", async () => {
    const { homeDir, sessionsDir, cachePath } = makeFixture()
    const firstProjectPath = path.join(homeDir, "workspace", "existing-project")
    const secondProjectPath = path.join(homeDir, "workspace", "new-project")
    writeSession({
      filePath: path.join(sessionsDir, "existing-session.jsonl"),
      projectPath: firstProjectPath,
      sessionId: "existing-session",
    })

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    await collectCodexProjects(homeDir, coldCache)
    expect(await coldCache.persist()).toBe(true)

    writeSession({
      filePath: path.join(sessionsDir, "new-session.jsonl"),
      projectPath: secondProjectPath,
      sessionId: "new-session",
    })
    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const warm = await collectCodexProjects(homeDir, warmCache)
    expect(warm.projects.map((project) => project.localPath).sort()).toEqual([
      firstProjectPath,
      secondProjectPath,
    ].sort())
    expect(warm.stats).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
  })

  test("reuses session metadata while a changed Codex session index updates recency", async () => {
    const { homeDir, sessionsDir, cachePath } = makeFixture()
    const sessionId = "indexed-session"
    const sessionPath = path.join(sessionsDir, "indexed-session.jsonl")
    const projectPath = path.join(homeDir, "workspace", "indexed-project")
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    writeSession({ filePath: sessionPath, projectPath, sessionId })
    writeFileSync(indexPath, `${JSON.stringify({
      id: sessionId,
      updated_at: "2026-07-29T03:00:00.000Z",
    })}\n`)

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const cold = await collectCodexProjects(homeDir, coldCache)
    expect(cold.projects[0]?.modifiedAt).toBe(Date.parse("2026-07-29T03:00:00.000Z"))
    expect(await coldCache.persist()).toBe(true)

    writeFileSync(indexPath, `${JSON.stringify({
      id: sessionId,
      updated_at: "2026-07-29T04:00:00.000Z",
    })}\n`)
    const changedTime = new Date("2026-07-29T04:00:01.000Z")
    utimesSync(indexPath, changedTime, changedTime)

    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const warm = await collectCodexProjects(homeDir, warmCache)
    expect(warm.projects[0]?.modifiedAt).toBe(Date.parse("2026-07-29T04:00:00.000Z"))
    expect(warm.stats).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
  })

  test("reparses renamed sources, evicts old keys, and drops deleted sessions authoritatively", async () => {
    const { homeDir, sessionsDir, cachePath } = makeFixture()
    const originalPath = path.join(sessionsDir, "original-session.jsonl")
    const renamedPath = path.join(sessionsDir, "renamed-session.jsonl")
    const projectPath = path.join(homeDir, "workspace", "rename-project")
    writeSession({ filePath: originalPath, projectPath })

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    await collectCodexProjects(homeDir, coldCache)
    expect(await coldCache.persist()).toBe(true)
    const originalFingerprint = statSync(originalPath)
    renameSync(originalPath, renamedPath)

    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const renamed = await collectCodexProjects(homeDir, warmCache)
    expect(renamed.projects.map((project) => project.localPath)).toEqual([projectPath])
    expect(renamed.stats).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
    expect(warmCache.getMatchingEntry(
      "codex",
      originalPath,
      {
        sizeBytes: originalFingerprint.size,
        mtimeMs: originalFingerprint.mtimeMs,
      },
      "codex-session",
    )).toBeNull()

    unlinkSync(renamedPath)
    const updates: Array<{ complete: boolean; paths: string[] }> = []
    const projects = await discoverProjectsIncrementally(
      homeDir,
      [new CodexProjectDiscoveryAdapter()],
      {
        cache: warmCache,
        onUpdate: (nextProjects, progress) => {
          updates.push({
            complete: progress.complete,
            paths: nextProjects.map((project) => project.localPath),
          })
        },
      },
    )

    expect(updates[0]).toEqual({ complete: false, paths: [projectPath] })
    expect(updates.at(-1)).toEqual({ complete: true, paths: [] })
    expect(projects).toEqual([])
    expect(warmCache.listProjects()).toEqual([])
  })

  test("reuses Claude marker metadata and re-resolves when its project disappears", async () => {
    const { homeDir, cachePath } = makeFixture()
    const projectPath = path.join(homeDir, "workspace", "claude-project")
    const markersDir = path.join(homeDir, ".claude", "projects")
    const markerPath = path.join(
      markersDir,
      projectPath.replace(/[^a-zA-Z0-9]/g, "-"),
    )
    mkdirSync(projectPath, { recursive: true })
    mkdirSync(markerPath, { recursive: true })

    const coldCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const cold = await collectClaudeProjects(homeDir, coldCache)
    expect(cold.projects.map((project) => project.localPath)).toEqual([projectPath])
    expect(cold.stats).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
    expect(await coldCache.persist()).toBe(true)

    const warmCache = await ProviderDiscoveryIndex.load({
      filePath: cachePath,
      sourceRoot: homeDir,
    })
    const warm = await collectClaudeProjects(homeDir, warmCache)
    expect(warm.projects.map((project) => project.localPath)).toEqual([projectPath])
    expect(warm.stats).toMatchObject({
      cacheHits: 1,
      cacheMisses: 0,
      sourcesParsed: 0,
    })

    rmSync(projectPath, { recursive: true, force: true })
    const removed = await collectClaudeProjects(homeDir, warmCache)
    expect(removed.projects).toEqual([])
    expect(removed.stats).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      sourcesParsed: 1,
    })
    expect(warmCache.listProjects(new Set(["claude"]))).toEqual([])
  })
})
