import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import type { AppSettingsSnapshot } from "../shared/types"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
  tempDirs.push(dir)
  return path.join(dir, "settings.json")
}

function expectedDisplayPath(filePath: string) {
  const homePath = homedir()
  return filePath.startsWith(`${homePath}${path.sep}`) ? `~${filePath.slice(homePath.length)}` : filePath
}

function expectedSettingsSnapshot(filePath: string, overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    browserSettingsMigrated: false,
    machineName: "This Machine",
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "claude-opus-4-8",
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "200k",
        },
        planMode: false,
        permissionMode: "acceptEdits",
      },
      codex: {
        model: "gpt-5.6-sol",
        modelOptions: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
        planMode: false,
        permissionMode: "full",
      },
    },
    warning: null,
    filePathDisplay: expectedDisplayPath(filePath),
    ...overrides,
  }
}

describe("readAppSettingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.browserSettingsMigrated).toBe(false)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("AppSettingsManager", () => {
  test("creates a settings file with default preferences", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()

    const payload = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
    expect(payload).not.toHaveProperty("analyticsEnabled")
    expect(payload).not.toHaveProperty("analyticsUserId")
    expect(manager.getSnapshot()).toEqual(expectedSettingsSnapshot(filePath))

    manager.dispose()
  })

  test("removes legacy analytics preferences and anonymous IDs", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, JSON.stringify({
      analyticsEnabled: true,
      analyticsUserId: "anon_legacy",
    }), "utf8")
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()
    const payload = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>

    expect(payload).not.toHaveProperty("analyticsEnabled")
    expect(payload).not.toHaveProperty("analyticsUserId")
    expect(manager.getSnapshot()).toEqual(expectedSettingsSnapshot(filePath))

    manager.dispose()
  })

  test("patches expanded settings", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

    await manager.initialize()

    const snapshot = await manager.writePatch({
      theme: "dark",
      chatSoundId: "glass",
      terminal: { scrollbackLines: 2_500 },
      editor: { preset: "vscode" },
      providerDefaults: {
        codex: {
          modelOptions: { reasoningEffort: "high", fastMode: true },
        },
      },
    })
    const nextPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      theme: string
      chatSoundId: string
      terminal: { scrollbackLines: number; minColumnWidth: number }
      editor: { preset: string; commandTemplate: string }
      providerDefaults: { codex: { modelOptions: { fastMode: boolean } } }
    }

    expect(snapshot.theme).toBe("dark")
    expect(snapshot.chatSoundId).toBe("glass")
    expect(snapshot.terminal.scrollbackLines).toBe(2_500)
    expect(snapshot.terminal.minColumnWidth).toBe(450)
    expect(snapshot.editor.preset).toBe("vscode")
    expect(snapshot.editor.commandTemplate).toBe("cursor {path}")
    expect(snapshot.providerDefaults.codex.modelOptions.fastMode).toBe(true)
    expect(nextPayload.theme).toBe("dark")
    expect(nextPayload.chatSoundId).toBe("glass")

    manager.dispose()
  })

  test("uses the system label as a default and persists a sanitized custom machine name", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath, { defaultMachineName: "  Office Mac\n" })

    await manager.initialize()
    expect(manager.getSnapshot().machineName).toBe("Office Mac")

    const snapshot = await manager.writePatch({ machineName: "  Studio\u0000 Mac\n" })
    const payload = JSON.parse(await readFile(filePath, "utf8")) as { machineName: string }

    expect(snapshot.machineName).toBe("Studio Mac")
    expect(payload.machineName).toBe("Studio Mac")

    manager.dispose()
  })
})
