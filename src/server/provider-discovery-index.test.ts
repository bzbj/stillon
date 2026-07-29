import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  canonicalizeProviderSourcePath,
  getProviderDiscoveryIndexPath,
  PROVIDER_DISCOVERY_PARSER_VERSIONS,
  ProviderDiscoveryIndex,
  type ClaudeProjectIndexEntry,
  type CodexSessionIndexEntry,
} from "./provider-discovery-index"

const tempDirs: string[] = []

async function makeTempDir() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-provider-index-"))
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function claudeEntry(homeDir: string): ClaudeProjectIndexEntry {
  const localPath = path.join(homeDir, "workspace", "alpha")
  return {
    provider: "claude",
    kind: "claude-project",
    sourcePath: canonicalizeProviderSourcePath(
      path.join(homeDir, ".claude", "projects", "alpha-marker"),
    ),
    sizeBytes: 128,
    mtimeMs: 200,
    parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["claude-project"],
    project: {
      localPath,
      title: "alpha",
      modifiedAt: 200,
    },
  }
}

function codexEntry(homeDir: string): CodexSessionIndexEntry {
  const localPath = path.join(homeDir, "workspace", "beta")
  return {
    provider: "codex",
    kind: "codex-session",
    sourcePath: canonicalizeProviderSourcePath(
      path.join(homeDir, ".codex", "sessions", "beta.jsonl"),
    ),
    sizeBytes: 256,
    mtimeMs: 300,
    parserVersion: PROVIDER_DISCOVERY_PARSER_VERSIONS["codex-session"],
    session: {
      id: "session-beta",
      cwd: localPath,
      metadataModifiedAt: 250,
    },
    project: {
      localPath,
      title: "beta",
      modifiedAt: 300,
    },
  }
}

describe("provider discovery index", () => {
  test("round-trips only bounded discovery metadata with private cache permissions", async () => {
    const root = await makeTempDir()
    const homeDir = path.join(root, "home")
    const dataDir = path.join(root, "data")
    const filePath = getProviderDiscoveryIndexPath(dataDir)
    await mkdir(homeDir, { recursive: true })

    const index = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    const claude = claudeEntry(homeDir)
    const codex = codexEntry(homeDir)
    index.replaceProviderEntries("claude", [claude])
    index.replaceProviderEntries("codex", [codex])
    expect(await index.persist()).toBe(true)

    const raw = await readFile(filePath, "utf8")
    const persisted = JSON.parse(raw) as {
      entries: Array<Record<string, unknown>>
    }
    expect(persisted.entries).toHaveLength(2)
    expect(Object.keys(
      persisted.entries.find((entry) => entry.kind === "codex-session") ?? {},
    ).sort()).toEqual([
      "kind",
      "mtimeMs",
      "parserVersion",
      "project",
      "provider",
      "session",
      "sizeBytes",
      "sourcePath",
    ])
    expect(raw).not.toContain("transcriptBody")
    expect(raw).not.toContain("toolResult")
    expect(raw).not.toContain("credential")

    const reloaded = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    expect(reloaded.listProjects().map((project) => ({
      provider: project.provider,
      title: project.title,
    })).sort((left, right) => left.provider.localeCompare(right.provider))).toEqual([
      { provider: "claude", title: "alpha" },
      { provider: "codex", title: "beta" },
    ])
    expect(reloaded.getMatchingEntry(
      "codex",
      codex.sourcePath,
      codex,
      "codex-session",
    )?.session?.id).toBe("session-beta")

    const fixedMtime = new Date("2000-01-01T00:00:00.000Z")
    await utimes(filePath, fixedMtime, fixedMtime)
    reloaded.replaceProviderEntries("codex", [codex])
    expect(await reloaded.persist()).toBe(true)
    expect(Math.abs((await stat(filePath)).mtimeMs - fixedMtime.getTime())).toBeLessThan(1_000)

    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700)
    }
  })

  test("replaces one provider without leaking or evicting the other", async () => {
    const root = await makeTempDir()
    const homeDir = path.join(root, "home")
    const index = await ProviderDiscoveryIndex.load({
      filePath: getProviderDiscoveryIndexPath(path.join(root, "data")),
      sourceRoot: homeDir,
    })

    index.replaceProviderEntries("claude", [claudeEntry(homeDir)])
    const claudeRevision = index.getProviderRevision("claude")
    index.replaceProviderEntries("codex", [codexEntry(homeDir)])
    expect(index.getProviderRevision("claude")).toBe(claudeRevision)
    expect(index.listProjects().map((project) => project.provider).sort()).toEqual([
      "claude",
      "codex",
    ])

    index.replaceProviderEntries("codex", [])
    expect(index.listProjects().map((project) => project.provider)).toEqual(["claude"])
  })

  test("atomically replaces an existing persisted snapshot", async () => {
    const root = await makeTempDir()
    const homeDir = path.join(root, "home")
    const filePath = getProviderDiscoveryIndexPath(path.join(root, "data"))
    const index = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    const initial = codexEntry(homeDir)
    index.replaceProviderEntries("codex", [initial])
    expect(await index.persist()).toBe(true)

    const updated: CodexSessionIndexEntry = {
      ...initial,
      sizeBytes: initial.sizeBytes + 1,
      mtimeMs: initial.mtimeMs + 1,
      project: initial.project
        ? { ...initial.project, modifiedAt: initial.project.modifiedAt + 1 }
        : null,
    }
    index.replaceProviderEntries("codex", [updated])
    expect(await index.persist()).toBe(true)

    const reloaded = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    expect(reloaded.getMatchingEntry(
      "codex",
      updated.sourcePath,
      updated,
      "codex-session",
    )?.project?.modifiedAt).toBe(301)
  })

  test("fails closed and removes corrupt, schema-mismatched, and parser-mismatched files", async () => {
    const root = await makeTempDir()
    const homeDir = path.join(root, "home")
    const filePath = getProviderDiscoveryIndexPath(path.join(root, "data"))
    await mkdir(path.dirname(filePath), { recursive: true })

    await writeFile(filePath, "{partial", "utf8")
    expect((await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })).listProjects()).toEqual([])
    expect(await Bun.file(filePath).exists()).toBe(false)

    await writeFile(filePath, JSON.stringify({
      schemaVersion: 0,
      platform: process.platform,
      sourceRoot: path.resolve(homeDir),
      entries: [],
    }), "utf8")
    expect((await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })).listProjects()).toEqual([])
    expect(await Bun.file(filePath).exists()).toBe(false)

    const valid = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    valid.replaceProviderEntries("codex", [codexEntry(homeDir)])
    expect(await valid.persist()).toBe(true)
    const mismatched = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Array<{ parserVersion: number }>
    }
    mismatched.entries[0]!.parserVersion = 999
    await writeFile(filePath, JSON.stringify(mismatched), "utf8")

    expect((await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })).listProjects()).toEqual([])
    expect(await Bun.file(filePath).exists()).toBe(false)
  })

  test("keeps the last atomic file and sweeps an orphaned partial temp write", async () => {
    const root = await makeTempDir()
    const homeDir = path.join(root, "home")
    const filePath = getProviderDiscoveryIndexPath(path.join(root, "data"))
    const index = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    index.replaceProviderEntries("claude", [claudeEntry(homeDir)])
    expect(await index.persist()).toBe(true)

    const orphanName = `.${path.basename(filePath)}.tmp-stale-partial`
    await writeFile(path.join(path.dirname(filePath), orphanName), "{partial", "utf8")

    const reloaded = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: homeDir })
    expect(reloaded.listProjects().map((project) => project.title)).toEqual(["alpha"])
    expect(await readdir(path.dirname(filePath))).not.toContain(orphanName)
  })

  test("treats a different home scope as a cache miss", async () => {
    const root = await makeTempDir()
    const firstHome = path.join(root, "first-home")
    const secondHome = path.join(root, "second-home")
    const filePath = getProviderDiscoveryIndexPath(path.join(root, "data"))
    const index = await ProviderDiscoveryIndex.load({ filePath, sourceRoot: firstHome })
    index.replaceProviderEntries("codex", [codexEntry(firstHome)])
    expect(await index.persist()).toBe(true)

    const isolated = await ProviderDiscoveryIndex.load({
      filePath,
      sourceRoot: secondHome,
    })
    expect(isolated.listProjects()).toEqual([])
  })
})
