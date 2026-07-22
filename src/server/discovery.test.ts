import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ClaudeProjectDiscoveryAdapter,
  CodexProjectDiscoveryAdapter,
  discoverProjects,
  discoverProjectsIncrementally,
  isProjectDiscoverySnapshotFresh,
  mergeIncrementalDiscoveryUpdate,
  type ProjectDiscoveryAdapter,
} from "./discovery"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-discovery-"))
  tempDirs.push(directory)
  return directory
}

function encodeClaudeProjectPath(localPath: string) {
  return localPath.replace(/[^a-zA-Z0-9]/g, "-")
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("project discovery", () => {
  test("Claude adapter decodes saved project paths", () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "alpha-project")
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects")
    const projectMarkerDir = path.join(claudeProjectsDir, encodeClaudeProjectPath(projectDir))

    mkdirSync(projectDir, { recursive: true })
    mkdirSync(projectMarkerDir, { recursive: true })
    utimesSync(projectMarkerDir, new Date("2026-03-16T10:00:00.000Z"), new Date("2026-03-16T10:00:00.000Z"))

    const projects = new ClaudeProjectDiscoveryAdapter().scan(homeDir)

    expect(projects).toEqual([
      {
        provider: "claude",
        localPath: projectDir,
        title: "alpha-project",
        modifiedAt: new Date("2026-03-16T10:00:00.000Z").getTime(),
      },
    ])
  })

  test("incremental Claude discovery prioritizes marker recency instead of encoded folder names", async () => {
    const homeDir = makeTempDir()
    const olderProjectDir = path.join(homeDir, "workspace", "z-older-project")
    const newerProjectDir = path.join(homeDir, "workspace", "a-newer-project")
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects")
    const olderMarkerDir = path.join(claudeProjectsDir, encodeClaudeProjectPath(olderProjectDir))
    const newerMarkerDir = path.join(claudeProjectsDir, encodeClaudeProjectPath(newerProjectDir))

    mkdirSync(olderProjectDir, { recursive: true })
    mkdirSync(newerProjectDir, { recursive: true })
    mkdirSync(olderMarkerDir, { recursive: true })
    mkdirSync(newerMarkerDir, { recursive: true })
    utimesSync(olderMarkerDir, new Date("2026-03-15T10:00:00.000Z"), new Date("2026-03-15T10:00:00.000Z"))
    utimesSync(newerMarkerDir, new Date("2026-03-16T10:00:00.000Z"), new Date("2026-03-16T10:00:00.000Z"))

    const projects = []
    for await (const project of new ClaudeProjectDiscoveryAdapter().scanIncrementally(homeDir)) {
      projects.push(project)
    }

    expect(projects.map((project) => project.localPath)).toEqual([
      newerProjectDir,
      olderProjectDir,
    ])
  })

  test("Codex adapter reads cwd from session metadata and ignores stale or invalid entries", () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "16")
    const liveProjectDir = path.join(homeDir, "workspace", "kanna")
    const missingProjectDir = path.join(homeDir, "workspace", "missing-project")
    mkdirSync(liveProjectDir, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(path.join(homeDir, ".codex", "session_index.jsonl"), [
      JSON.stringify({
        id: "session-live",
        updated_at: "2026-03-16T23:05:58.940134Z",
      }),
      JSON.stringify({
        id: "session-missing",
        updated_at: "2026-03-16T20:05:58.940134Z",
      }),
      JSON.stringify({
        id: "session-relative",
        updated_at: "2026-03-16T21:05:58.940134Z",
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T23-05-52-session-live.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T23:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-live",
          cwd: liveProjectDir,
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T20-05-52-session-missing.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T20:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-missing",
          cwd: missingProjectDir,
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T21-05-52-session-relative.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-16T21:05:52.000Z",
        type: "session_meta",
        payload: {
          id: "session-relative",
          cwd: "./relative-path",
        },
      }),
    ].join("\n"))

    const projects = new CodexProjectDiscoveryAdapter().scan(homeDir)

    expect(projects).toEqual([
      {
        provider: "codex",
        localPath: liveProjectDir,
        title: "kanna",
        modifiedAt: Date.parse("2026-03-16T23:05:58.940134Z"),
      },
    ])
  })

  test("Codex adapter falls back to session timestamps and config projects when session index misses CLI entries", () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "16")
    const cliProjectDir = path.join(homeDir, "workspace", "codex-test-2")
    const configOnlyProjectDir = path.join(homeDir, "workspace", "config-only")
    mkdirSync(cliProjectDir, { recursive: true })
    mkdirSync(configOnlyProjectDir, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(path.join(homeDir, ".codex", "session_index.jsonl"), "")
    writeFileSync(path.join(homeDir, ".codex", "config.toml"), [
      `personality = "pragmatic"`,
      `[projects."${configOnlyProjectDir}"]`,
      `trust_level = "trusted"`,
    ].join("\n"))

    writeFileSync(path.join(sessionsDir, "rollout-2026-03-16T23-42-24-cli-session.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-17T03:42:25.751Z",
        type: "session_meta",
        payload: {
          id: "cli-session",
          timestamp: "2026-03-17T03:42:24.578Z",
          cwd: cliProjectDir,
          originator: "codex-tui",
          source: "cli",
        },
      }),
    ].join("\n"))

    const projects = new CodexProjectDiscoveryAdapter().scan(homeDir)

    expect(projects.map((project) => project.localPath).sort()).toEqual([
      cliProjectDir,
      configOnlyProjectDir,
    ].sort())
    expect(projects.find((project) => project.localPath === cliProjectDir)?.modifiedAt).toBe(
      Date.parse("2026-03-17T03:42:25.751Z")
    )
  })

  test("discoverProjects de-dupes provider results by normalized path and keeps the newest timestamp", () => {
    const adapters: ProjectDiscoveryAdapter[] = [
      {
        provider: "claude",
        scan() {
          return [
            {
              provider: "claude",
              localPath: "/tmp/project",
              title: "Claude Project",
              modifiedAt: 10,
            },
          ]
        },
      },
      {
        provider: "codex",
        scan() {
          return [
            {
              provider: "codex",
              localPath: "/tmp/project",
              title: "Codex Project",
              modifiedAt: 20,
            },
            {
              provider: "codex",
              localPath: "/tmp/other-project",
              title: "Other Project",
              modifiedAt: 15,
            },
          ]
        },
      },
    ]

    expect(discoverProjects("/unused-home", adapters)).toEqual([
      {
        localPath: "/tmp/project",
        title: "Codex Project",
        modifiedAt: 20,
      },
      {
        localPath: "/tmp/other-project",
        title: "Other Project",
        modifiedAt: 15,
      },
    ])
  })

  test("incremental discovery publishes saved projects before provider history and streams later results", async () => {
    let continueScan: () => void = () => {}
    const scanGate = new Promise<void>((resolve) => {
      continueScan = resolve
    })
    const updates: Array<Array<{ localPath: string; title: string; modifiedAt: number }>> = []
    const adapter: ProjectDiscoveryAdapter = {
      provider: "codex",
      scan: () => [],
      async *scanIncrementally() {
        await scanGate
        yield {
          provider: "codex",
          localPath: "/tmp/discovered-project",
          title: "Discovered Project",
          modifiedAt: 20,
        }
      },
    }

    const discovery = discoverProjectsIncrementally("/unused-home", [adapter], {
      initialProjects: [{
        localPath: "/tmp/saved-project",
        title: "Saved Project",
        modifiedAt: 10,
      }],
      updateBatchSize: 1,
      onUpdate: (projects) => {
        updates.push(projects)
      },
    })

    await Promise.resolve()
    expect(updates).toEqual([[
      {
        localPath: "/tmp/saved-project",
        title: "Saved Project",
        modifiedAt: 10,
      },
    ]])

    continueScan()
    await expect(discovery).resolves.toEqual([
      {
        localPath: "/tmp/discovered-project",
        title: "Discovered Project",
        modifiedAt: 20,
      },
      {
        localPath: "/tmp/saved-project",
        title: "Saved Project",
        modifiedAt: 10,
      },
    ])
    expect(updates.at(-1)).toEqual([
      {
        localPath: "/tmp/discovered-project",
        title: "Discovered Project",
        modifiedAt: 20,
      },
      {
        localPath: "/tmp/saved-project",
        title: "Saved Project",
        modifiedAt: 10,
      },
    ])
  })

  test("a project saved during an in-flight scan survives the final discovery snapshot", () => {
    expect(mergeIncrementalDiscoveryUpdate({
      currentProjects: [{
        localPath: "/tmp/original-saved-project",
        title: "Original Saved Project",
        modifiedAt: 10,
      }],
      discoveredProjects: [{
        localPath: "/tmp/provider-project",
        title: "Provider Project",
        modifiedAt: 20,
      }],
      savedProjects: [
        {
          localPath: "/tmp/original-saved-project",
          title: "Original Saved Project",
          modifiedAt: 10,
        },
        {
          localPath: "/tmp/newly-opened-project",
          title: "Newly Opened Project",
          modifiedAt: 30,
        },
      ],
      complete: true,
    })).toEqual([
      {
        localPath: "/tmp/newly-opened-project",
        title: "Newly Opened Project",
        modifiedAt: 30,
      },
      {
        localPath: "/tmp/provider-project",
        title: "Provider Project",
        modifiedAt: 20,
      },
      {
        localPath: "/tmp/original-saved-project",
        title: "Original Saved Project",
        modifiedAt: 10,
      },
    ])
  })

  test("reuses a recently completed discovery snapshot until its freshness window expires", () => {
    const completedAt = 1_000
    expect(isProjectDiscoverySnapshotFresh(null, completedAt)).toBe(false)
    expect(isProjectDiscoverySnapshotFresh(completedAt, completedAt + 59_999)).toBe(true)
    expect(isProjectDiscoverySnapshotFresh(completedAt, completedAt + 60_000)).toBe(false)
  })

  test("incremental discovery stops without publishing a complete snapshot when aborted", async () => {
    const abortController = new AbortController()
    const progress: boolean[] = []
    const adapter: ProjectDiscoveryAdapter = {
      provider: "codex",
      scan: () => [],
      async *scanIncrementally() {
        yield {
          provider: "codex",
          localPath: "/tmp/first-project",
          title: "First Project",
          modifiedAt: 10,
        }
        yield {
          provider: "codex",
          localPath: "/tmp/second-project",
          title: "Second Project",
          modifiedAt: 20,
        }
      },
    }

    const discovery = discoverProjectsIncrementally("/unused-home", [adapter], {
      signal: abortController.signal,
      updateBatchSize: 1,
      onUpdate: (_projects, update) => {
        progress.push(update.complete)
        if (progress.length === 2) {
          abortController.abort()
        }
      },
    })

    await expect(discovery).rejects.toHaveProperty("name", "AbortError")
    expect(progress).toEqual([false, false])
  })

  test("incremental Codex discovery reads session metadata without loading the transcript body", async () => {
    const homeDir = makeTempDir()
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "16")
    const projectDir = path.join(homeDir, "workspace", "incremental-project")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })

    const metadata = JSON.stringify({
      timestamp: "2026-03-17T03:42:25.751Z",
      type: "session_meta",
      payload: {
        id: "incremental-session",
        cwd: projectDir,
      },
    })
    writeFileSync(
      path.join(sessionsDir, "rollout-2026-03-16T23-42-24-incremental-session.jsonl"),
      `${metadata}\n${"x".repeat(2 * 1024 * 1024)}`
    )

    const adapter = new CodexProjectDiscoveryAdapter()
    const projects = []
    for await (const project of adapter.scanIncrementally(homeDir)) {
      projects.push(project)
    }

    expect(projects).toEqual([{
      provider: "codex",
      localPath: projectDir,
      title: "incremental-project",
      modifiedAt: Date.parse("2026-03-17T03:42:25.751Z"),
    }])
  })
})
