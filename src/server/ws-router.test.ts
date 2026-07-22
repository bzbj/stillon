import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  AppSettingsSnapshot,
  KeybindingsSnapshot,
  LlmProviderSnapshot,
  SubscriptionUsageSnapshot,
} from "../shared/types"
import { PROTOCOL_VERSION } from "../shared/types"
import { createEmptyState } from "./events"
import {
  assertSafeSkillId,
  assertSafeSkillSource,
  buildInstallSkillCommand,
  buildUninstallSkillCommand,
  createWsRouter,
  listInstalledSkills,
  parseInstalledSkillsLock,
} from "./ws-router"

function withSidebarGroupDefaults(group: {
  groupKey: string
  title: string
  realTitle?: string
  localPath: string
  chats: Array<{
    _id: string
    _creationTime: number
    chatId: string
    title: string
    status: "idle" | "starting" | "running" | "waiting_for_user" | "failed"
    unread: boolean
    localPath: string
    provider: "claude" | "codex" | null
    lastMessageAt?: number
    canFork?: boolean
    hasAutomation: boolean
  }>
}) {
  return {
    ...group,
    realTitle: group.realTitle ?? group.title,
    previewChats: group.chats,
    olderChats: [],
    defaultCollapsed: true,
  }
}

class FakeWebSocket {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
    protectedDraftChatIds: new Set<string>(),
  }

  send(message: string) {
    this.sent.push(JSON.parse(message))
  }
}

const DEFAULT_KEYBINDINGS_SNAPSHOT: KeybindingsSnapshot = {
  bindings: {
    toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
    toggleRightSidebar: ["ctrl+b"],
    openInFinder: ["cmd+alt+f"],
    openInEditor: ["cmd+shift+o"],
    addSplitTerminal: ["cmd+shift+j"],
    jumpToSidebarChat: ["cmd+alt"],
    createChatInCurrentProject: ["cmd+alt+n"],
    openAddProject: ["cmd+alt+o"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const DEFAULT_APP_SETTINGS_SNAPSHOT: AppSettingsSnapshot = {
  browserSettingsMigrated: false,
  machineName: "Local Machine",
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
      permissionMode: "acceptEdits",
    },
    codex: {
      model: "gpt-5.5",
      modelOptions: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
      permissionMode: "full",
    },
  },
  network: {
    mode: "system",
    httpProxy: "",
    httpsProxy: "",
    allProxy: "",
    noProxy: "localhost,127.0.0.1,::1",
  },
  warning: null,
  filePathDisplay: "~/.kanna/data/settings.json",
}

describe("skills helpers", () => {
  test("parses installed global skills from a lock payload", () => {
    const snapshot = parseInstalledSkillsLock({
      version: 1,
      skills: {
        zeta: {
          source: "owner/zeta",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/zeta",
          skillPath: "skills/zeta/SKILL.md",
          installedAt: "2026-05-01T01:00:00.000Z",
          updatedAt: "2026-05-01T02:00:00.000Z",
          pluginName: "zeta-plugin",
        },
        alpha: {
          source: "owner/alpha",
          sourceType: "github",
        },
        ignored: "not an object",
      },
    }, "/tmp/.skill-lock.json")

    expect(snapshot.lockFilePath).toBe("/tmp/.skill-lock.json")
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"])
    expect(snapshot.skills[0]).toMatchObject({
      name: "alpha",
      source: "owner/alpha",
      sourceType: "github",
      sourceUrl: "",
      installedAt: "",
      updatedAt: "",
    })
    expect(snapshot.skills[1]).toMatchObject({
      name: "zeta",
      source: "owner/zeta",
      skillPath: "skills/zeta/SKILL.md",
      pluginName: "zeta-plugin",
    })
  })

  test("returns an empty installed skills snapshot when the lock file is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-skills-"))
    try {
      const missingPath = path.join(dir, "missing.json")
      expect(await listInstalledSkills(missingPath)).toEqual({
        lockFilePath: missingPath,
        skills: [],
      })

      const invalidPath = path.join(dir, ".skill-lock.json")
      await writeFile(invalidPath, "{", "utf8")
      expect(await listInstalledSkills(invalidPath)).toEqual({
        lockFilePath: invalidPath,
        skills: [],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("validates skill source and id before building commands", () => {
    expect(assertSafeSkillSource(" owner/repo ")).toBe("owner/repo")
    expect(assertSafeSkillId(" my-skill_1 ")).toBe("my-skill_1")
    expect(() => assertSafeSkillSource("https://github.com/owner/repo")).toThrow("owner/repo")
    expect(() => assertSafeSkillId("../nope")).toThrow("Skill id is invalid.")
  })

  test("builds global install and uninstall commands for universal and Claude Code aliases", () => {
    expect(buildInstallSkillCommand("owner/repo", "my-skill").slice(1)).toEqual([
      "skills",
      "add",
      "owner/repo",
      "--skill",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
    expect(buildUninstallSkillCommand("my-skill").slice(1)).toEqual([
      "skills",
      "remove",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
  })
})

describe("local project discovery subscriptions", () => {
  test("sends saved projects immediately while provider history refresh is still running", async () => {
    let isDiscovering = true
    let finishRefresh: () => void = () => {}
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const state = createEmptyState()
    state.projectsById.set("saved-project", {
      id: "saved-project",
      localPath: "/tmp/saved-project",
      title: "Saved Project",
      createdAt: 5,
      updatedAt: 10,
    })
    state.projectIdsByPath.set("/tmp/saved-project", "saved-project")
    const router = createWsRouter({
      store: { state } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => {
        await refreshGate
        return []
      },
      getDiscoveredProjects: () => [],
      isDiscoveryInProgress: () => isDiscovering,
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(ws as never, JSON.stringify({
      v: PROTOCOL_VERSION,
      type: "subscribe",
      id: "local-projects-1",
      topic: { type: "local-projects" },
    }))

    expect(ws.sent).toEqual([{
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "local-projects-1",
      snapshot: {
        type: "local-projects",
        data: {
          machine: {
            id: "local",
            displayName: "Local Machine",
            platform: process.platform,
          },
          projects: [{
            localPath: "/tmp/saved-project",
            title: "Saved Project",
            source: "saved",
            lastOpenedAt: 10,
            chatCount: 0,
          }],
          isDiscovering: true,
        },
      },
    }])

    isDiscovering = false
    finishRefresh()
    await Bun.sleep(0)
    expect(ws.sent.at(-1)).toMatchObject({
      snapshot: {
        type: "local-projects",
        data: { isDiscovering: false },
      },
    })
    router.dispose()
  })

  test("forces discovery invalidation after opening a project", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "stillon-open-project-"))
    const state = createEmptyState()
    const refreshOptions: Array<{ force?: boolean } | undefined> = []
    const router = createWsRouter({
      store: {
        state,
        openProject: async (localPath: string) => {
          const project = {
            id: "opened-project",
            localPath,
            title: "Opened Project",
            createdAt: 10,
            updatedAt: 10,
          }
          state.projectsById.set(project.id, project)
          state.projectIdsByPath.set(project.localPath, project.id)
          return project
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async (options) => {
        refreshOptions.push(options)
        return []
      },
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    try {
      await router.handleMessage(ws as never, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "command",
        id: "open-project-1",
        command: { type: "project.open", localPath: projectDir },
      }))

      expect(refreshOptions).toEqual([{ force: true }])
      expect(ws.sent).toContainEqual({
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "open-project-1",
        result: { projectId: "opened-project" },
      })
    } finally {
      router.dispose()
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

describe("filesystem commands", () => {
  test("acks paths resolved by the connected host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-ws-resolve-path-"))
    try {
      const router = createWsRouter({
        store: { state: createEmptyState() } as never,
        agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
        terminals: {
          getSnapshot: () => null,
          onEvent: () => () => {},
        } as never,
        keybindings: {
          getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
          onChange: () => () => {},
        } as never,
        refreshDiscovery: async () => [],
        getDiscoveredProjects: () => [],
        machineDisplayName: "Local Machine",
      })
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "resolve-path-1",
          command: { type: "filesystem.resolvePath", localPath: root },
        })
      )

      expect(ws.sent).toEqual([{
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "resolve-path-1",
        result: {
          path: root,
          separator: path.sep,
        },
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("acks one-level directory listings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-ws-local-directories-"))
    try {
      await mkdir(path.join(root, "beta", "nested"), { recursive: true })
      await mkdir(path.join(root, "alpha"), { recursive: true })
      await writeFile(path.join(root, "file.txt"), "not a directory", "utf8")
      const router = createWsRouter({
        store: { state: createEmptyState() } as never,
        agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
        terminals: {
          getSnapshot: () => null,
          onEvent: () => () => {},
        } as never,
        keybindings: {
          getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
          onChange: () => () => {},
        } as never,
        refreshDiscovery: async () => [],
        getDiscoveredProjects: () => [],
        machineDisplayName: "Local Machine",
      })
      const ws = new FakeWebSocket()

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: 1,
          type: "command",
          id: "directories-1",
          command: { type: "filesystem.listDirectories", localPath: root },
        })
      )

      expect(ws.sent).toEqual([{
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "directories-1",
        result: {
          path: root,
          parentPath: path.dirname(root),
          entries: [
            { name: "alpha", path: path.join(root, "alpha") },
            { name: "beta", path: path.join(root, "beta") },
          ],
        },
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const DEFAULT_LLM_PROVIDER_SNAPSHOT: LlmProviderSnapshot = {
  provider: "openai",
  apiKey: "",
  model: "",
  baseUrl: "",
  resolvedBaseUrl: "https://api.openai.com/v1",
  enabled: false,
  warning: null,
  filePathDisplay: "~/.kanna/llm-provider.json",
}

const DEFAULT_SUBSCRIPTION_USAGE_SNAPSHOT: SubscriptionUsageSnapshot = {
  generatedAt: 1_782_799_000_000,
  providers: [
    {
      provider: "codex",
      label: "Codex",
      status: "available",
      planType: "pro",
      accountEmail: "codex@example.com",
      source: "Latest local Codex token_count event",
      updatedAt: 1_782_798_900_000,
      error: null,
      windows: [
        {
          id: "five_hour",
          label: "5-hour window",
          usedPercent: 18,
          windowMinutes: 300,
          resetsAt: 1_782_808_000_000,
          resetsAtText: null,
        },
        {
          id: "weekly",
          label: "Weekly window",
          usedPercent: 4,
          windowMinutes: 10_080,
          resetsAt: 1_783_000_000_000,
          resetsAtText: null,
        },
      ],
    },
    {
      provider: "claude",
      label: "Claude Code",
      status: "available",
      planType: "pro",
      accountEmail: "claude@example.com",
      source: "claude /usage",
      updatedAt: 1_782_799_000_000,
      error: null,
      windows: [
        {
          id: "five_hour",
          label: "5-hour window",
          usedPercent: 0,
          windowMinutes: 300,
          resetsAt: 1_782_810_000_000,
          resetsAtText: "Jun 30 at 9:29pm (Asia/Shanghai)",
        },
        {
          id: "weekly",
          label: "Weekly window",
          usedPercent: 5,
          windowMinutes: 10_080,
          resetsAt: 1_782_840_000_000,
          resetsAtText: "Jul 1 at 4:59am (Asia/Shanghai)",
        },
      ],
    },
  ],
}

describe("ws-router", () => {
  test("acks system.ping without broadcasting snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    ws.data.subscriptions.set("sub-1", { type: "sidebar" })
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ping-1",
        command: { type: "system.ping" },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "ping-1",
      },
    ])
  })

  test("reads and writes llm provider settings via commands", async () => {
    const writes: Array<Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">> = []
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      llmProvider: {
        read: async () => DEFAULT_LLM_PROVIDER_SNAPSHOT,
        write: async (value) => {
          writes.push(value)
          return {
            ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
            ...value,
            resolvedBaseUrl: value.provider === "custom" ? value.baseUrl : "https://api.openai.com/v1",
            enabled: Boolean(value.apiKey && value.model),
          }
        },
        validate: async () => ({
          ok: true,
          error: null,
        }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-read-1",
        command: { type: "settings.readLlmProvider" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "llm-write-1",
        command: {
          type: "settings.writeLlmProvider",
          provider: "custom",
          apiKey: "test-key",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-read-1",
        result: DEFAULT_LLM_PROVIDER_SNAPSHOT,
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "llm-write-1",
        result: {
          ...DEFAULT_LLM_PROVIDER_SNAPSHOT,
          provider: "custom",
          apiKey: "test-key",
          model: "gpt-test",
          baseUrl: "https://example.com/v1",
          resolvedBaseUrl: "https://example.com/v1",
          enabled: true,
        },
      },
    ])
    expect(writes).toEqual([{
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://example.com/v1",
    }])
  })

  test("reads subscription usage via command", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      subscriptionUsage: {
        read: async () => DEFAULT_SUBSCRIPTION_USAGE_SNAPSHOT,
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "usage-read-1",
        command: { type: "settings.readSubscriptionUsage" },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "usage-read-1",
        result: DEFAULT_SUBSCRIPTION_USAGE_SNAPSHOT,
      },
    ])
  })

  test("routes Agent network status, detection, testing, and durable restart state", async () => {
    let snapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
    let restartCalls = 0
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
        restartSessions: () => {
          restartCalls += 1
          return { restarted: true, closedClaudeSessions: 1 }
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => snapshot,
        writePatch: async (patch) => {
          snapshot = {
            ...snapshot,
            network: { ...snapshot.network, ...patch.network },
          }
          return snapshot
        },
      },
      agentNetwork: {
        readStatus: () => ({
          mode: snapshot.network.mode,
          source: "system",
          sourceLabel: "System network or VPN routing",
          effectiveProxy: [],
          restartRequired: false,
        }),
        detect: async () => ({
          status: "detected",
          platform: "darwin",
          sourceLabel: "macOS System Configuration",
          settings: {
            mode: "detected",
            httpProxy: "http://127.0.0.1:7890",
            httpsProxy: "",
            allProxy: "",
            noProxy: "localhost,127.0.0.1,::1",
          },
          message: "Detected system proxy values. Review them before saving.",
          pacUrlDetected: false,
        }),
        testConnection: async (provider) => ({
          ok: true,
          provider,
          targetLabel: "Claude API",
          sourceLabel: "System network or VPN routing",
          proxy: null,
          durationMs: 12,
          errorCode: null,
          message: "Claude API is reachable through the system network.",
        }),
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)
    const command = async (id: string, value: Record<string, unknown>) => {
      await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id, command: value }))
    }

    await command("network-status-before", { type: "settings.readAgentNetworkStatus" })
    await command("network-detect", { type: "settings.detectSystemProxy" })
    await command("network-test", { type: "settings.testAgentNetworkConnection", provider: "claude" })
    await command("network-save", {
      type: "settings.writeAppSettingsPatch",
      patch: { network: { mode: "manual", httpsProxy: "http://127.0.0.1:7890" } },
    })
    await command("network-status-pending", { type: "settings.readAgentNetworkStatus" })
    await command("network-restart", { type: "settings.restartAgentSessions" })
    await command("network-status-after", { type: "settings.readAgentNetworkStatus" })

    const byId = new Map(ws.sent.map((message: any) => [message.id, message]))
    expect(byId.get("network-status-before")?.result.restartRequired).toBe(false)
    expect(byId.get("network-detect")?.result.settings.httpProxy).toBe("http://127.0.0.1:7890")
    expect(byId.get("network-test")?.result.ok).toBe(true)
    expect(byId.get("network-status-pending")?.result.restartRequired).toBe(true)
    expect(byId.get("network-restart")?.result).toEqual({ restarted: true, closedClaudeSessions: 1 })
    expect(byId.get("network-status-after")?.result.restartRequired).toBe(false)
    expect(restartCalls).toBe(1)
  })

  test("subscribes to app settings and writes patches through the router", async () => {
    let snapshot: AppSettingsSnapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
    let listener: ((nextSnapshot: AppSettingsSnapshot) => void) | null = null
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => snapshot,
        writePatch: async (patch) => {
          snapshot = {
            ...snapshot,
            browserSettingsMigrated: patch.browserSettingsMigrated ?? snapshot.browserSettingsMigrated,
            theme: patch.theme ?? snapshot.theme,
            chatSoundPreference: patch.chatSoundPreference ?? snapshot.chatSoundPreference,
            chatSoundId: patch.chatSoundId ?? snapshot.chatSoundId,
            defaultProvider: patch.defaultProvider ?? snapshot.defaultProvider,
            terminal: { ...snapshot.terminal, ...patch.terminal },
            editor: { ...snapshot.editor, ...patch.editor },
          }
          listener?.(snapshot)
          return snapshot
        },
        onChange: (nextListener) => {
          listener = nextListener
          return () => {
            listener = null
          }
        },
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "app-settings-sub-1",
        topic: { type: "app-settings" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "settings-patch-1",
        command: {
          type: "settings.writeAppSettingsPatch",
          patch: {
            theme: "dark",
            terminal: { scrollbackLines: 2_000 },
          },
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: DEFAULT_APP_SETTINGS_SNAPSHOT,
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id: "app-settings-sub-1",
        snapshot: {
          type: "app-settings",
          data: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT,
            theme: "dark",
            terminal: {
              ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
              scrollbackLines: 2_000,
            },
          },
        },
      },
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "settings-patch-1",
        result: {
          ...DEFAULT_APP_SETTINGS_SNAPSHOT,
          theme: "dark",
          terminal: {
            ...DEFAULT_APP_SETTINGS_SNAPSHOT.terminal,
            scrollbackLines: 2_000,
          },
        },
      },
    ])
  })

  test("pushes a refreshed local machine snapshot after its name changes", () => {
    let snapshot: AppSettingsSnapshot = DEFAULT_APP_SETTINGS_SNAPSHOT
    let listener: (nextSnapshot: AppSettingsSnapshot) => void = () => {}
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      appSettings: {
        getSnapshot: () => snapshot,
        onChange: (nextListener) => {
          listener = nextListener
          return () => {
            listener = () => {}
          }
        },
      },
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: () => snapshot.machineName,
    })
    const ws = new FakeWebSocket()
    ws.data.subscriptions.set("local-projects-sub-1", { type: "local-projects" })
    router.handleOpen(ws as never)

    snapshot = { ...snapshot, machineName: "Office Mac" }
    listener(snapshot)

    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "local-projects-sub-1",
      snapshot: {
        type: "local-projects",
        data: {
          machine: {
            id: "local",
            displayName: "Office Mac",
            platform: process.platform,
          },
          projects: [],
        },
      },
    })
  })

  test("acks terminal.input without rebroadcasting terminal snapshots", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
        write: () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    ws.data.subscriptions.set("sub-terminal", { type: "terminal", terminalId: "terminal-1" })
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "terminal-input-1",
        command: {
          type: "terminal.input",
          terminalId: "terminal-1",
          data: "ls\r",
        },
      })
    )

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "ack",
        id: "terminal-input-1",
      },
    ])
  })

  test("subscribes and unsubscribes chat topics", async () => {
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub-1",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "chat-sub-1",
      snapshot: {
        type: "chat",
        data: null,
      },
    })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "unsubscribe",
        id: "chat-sub-1",
      })
    )

    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "chat-sub-1",
    })
  })

  test("reuses one sidebar derivation across sockets in the same broadcast pass", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    let activeStatusCalls = 0
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => {
          activeStatusCalls += 1
          return new Map()
        },
        getDrainingChatIds: () => new Set(),
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })

    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()
    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)
    wsA.data.subscriptions.set("sidebar-a", { type: "sidebar" })
    wsB.data.subscriptions.set("sidebar-b", { type: "sidebar" })

    await router.broadcastSnapshots()

    expect(activeStatusCalls).toBe(1)
    expect(wsA.sent).toHaveLength(1)
    expect(wsB.sent).toHaveLength(1)
  })

  test("subscribes to project git snapshots independently from chat snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: () => state.projectsById.get("project-1") ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "project-git-sub-1",
        topic: { type: "project-git", projectId: "project-1" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "project-git-sub-1",
      snapshot: {
        type: "project-git",
        data: {
          status: "ready",
          branchName: "main",
          files: [],
          branchHistory: { entries: [] },
        },
      },
    })
  })

  test("reads diff patches through the project-scoped command", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => null,
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 1, hasConflicts: false, message: "ready" }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "diff --git a/app.txt b/app.txt" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "read-patch-1",
        command: {
          type: "project.readDiffPatch",
          projectId: "project-1",
          path: "app.txt",
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "read-patch-1",
      result: { patch: "diff --git a/app.txt b/app.txt" },
    })
  })

  test("routes merge preview and merge commands through the diff store", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready", branchName: "main", files: [], branchHistory: { entries: [] } }),
        refreshSnapshot: async () => false,
        listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        previewMergeBranch: async () => ({ currentBranchName: "main", targetBranchName: "feature/test", targetDisplayName: "feature/test", status: "mergeable", commitCount: 2, hasConflicts: false, message: "2 commits from feature/test will merge into main." }),
        mergeBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: true }),
        syncBranch: async () => ({ ok: true, action: "fetch", snapshotChanged: false }),
        checkoutBranch: async () => ({ ok: true, snapshotChanged: false }),
        createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "", usedFallback: true, failureMessage: null }),
        commitFiles: async () => ({ ok: true, mode: "commit_only", pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async () => ({ snapshotChanged: false }),
        readPatch: async () => ({ patch: "" }),
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "preview-merge-1",
        command: {
          type: "chat.previewMergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "merge-1",
        command: {
          type: "chat.mergeBranch",
          chatId: "chat-1",
          branch: { kind: "local", name: "feature/test" },
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "preview-merge-1",
      result: {
        currentBranchName: "main",
        targetBranchName: "feature/test",
        targetDisplayName: "feature/test",
        status: "mergeable",
        commitCount: 2,
        hasConflicts: false,
        message: "2 commits from feature/test will merge into main.",
      },
    })
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "merge-1",
      result: {
        ok: true,
        branchName: "main",
        snapshotChanged: true,
      },
    })
  })

  test("loads older chat history pages", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const router = createWsRouter({
      store: {
        state,
        getMessagesPageBefore: () => ({
          messages: [{
            _id: "msg-1",
            kind: "assistant_text",
            createdAt: 1,
            text: "older message",
          }],
          hasOlder: false,
          olderCursor: null,
        }),
        getChat: () => state.chatsById.get("chat-1") ?? null,
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "history-1",
        command: {
          type: "chat.loadHistory",
          chatId: "chat-1",
          beforeCursor: "idx:100",
          limit: 100,
        },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "history-1",
      result: {
        messages: [{
          _id: "msg-1",
          kind: "assistant_text",
          createdAt: 1,
          text: "older message",
        }],
        hasOlder: false,
        olderCursor: null,
      },
    })
  })

  test("marks chats read and rebroadcasts sidebar snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: true,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const store = {
      state,
      async setChatReadState(chatId: string, unread: boolean) {
        const chat = state.chatsById.get(chatId)
        if (!chat) throw new Error("Chat not found")
        chat.unread = unread
      },
    }

    const router = createWsRouter({
      store: store as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const wsA = new FakeWebSocket()
    const wsB = new FakeWebSocket()

    router.handleOpen(wsA as never)
    router.handleOpen(wsB as never)

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-a",
        topic: { type: "sidebar" },
      })
    )
    await router.handleMessage(
      wsB as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-b",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      wsA as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "mark-read-1",
        command: { type: "chat.markRead", chatId: "chat-1" },
      })
    )

    expect(wsA.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "mark-read-1",
    })
    expect(wsA.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-a",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
    expect(wsB.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-b",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: null,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("reorders sidebar project groups on the server and rebroadcasts the snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "Project 1",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Project 2",
      createdAt: 2,
      updatedAt: 2,
    })

    const setSidebarProjectOrderCalls: string[][] = []
    let sidebarProjectOrder: string[] = []
    const router = createWsRouter({
      store: {
        state,
        getSidebarProjectOrder() {
          return [...sidebarProjectOrder]
        },
        async setSidebarProjectOrder(projectIds: string[]) {
          setSidebarProjectOrderCalls.push(projectIds)
          sidebarProjectOrder = [...projectIds]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "sidebar-reorder-1",
        command: { type: "sidebar.reorderProjectGroups", projectIds: ["project-1", "project-2"] },
      })
    )

    expect(setSidebarProjectOrderCalls).toEqual([["project-1", "project-2"]])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "sidebar-reorder-1",
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [
            withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project 1",
              localPath: "/tmp/project-1",
              chats: [],
            }),
            withSidebarGroupDefaults({
              groupKey: "project-2",
              title: "Project 2",
              localPath: "/tmp/project-2",
              chats: [],
            }),
          ],
        },
      },
    })
  })

  test("forks a chat through the agent and rebroadcasts the sidebar snapshot", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: "session-1",
      pendingForkSessionToken: null,
      lastTurnOutcome: null,
    })

    const forkChatCalls: string[] = []
    const router = createWsRouter({
      store: { state } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        getDrainingChatIds: () => new Set(),
          forkChat: async (chatId: string) => {
          forkChatCalls.push(chatId)
          state.chatsById.set("chat-fork-1", {
            id: "chat-fork-1",
            projectId: "project-1",
            title: "Fork: Chat",
            createdAt: 2,
            updatedAt: 2,
            unread: false,
            provider: "claude",
            planMode: false,
            sessionToken: null,
            pendingForkSessionToken: "session-1",
            lastTurnOutcome: null,
          })
          return { chatId: "chat-fork-1" }
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "fork-1",
        command: { type: "chat.fork", chatId: "chat-1" },
      })
    )

    expect(forkChatCalls).toEqual(["chat-1"])
    expect(ws.sent.at(-2)).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "fork-1",
      result: { chatId: "chat-fork-1" },
    })
    expect(ws.sent.at(-1)).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [withSidebarGroupDefaults({
            groupKey: "project-1",
            title: "Project",
            localPath: "/tmp/project",
            chats: [{
              _id: "chat-fork-1",
              _creationTime: 2,
              chatId: "chat-fork-1",
              title: "Fork: Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }, {
              _id: "chat-1",
              _creationTime: 1,
              chatId: "chat-1",
              title: "Chat",
              status: "idle",
              unread: false,
              localPath: "/tmp/project",
              provider: "claude",
              canFork: true,
              hasAutomation: false,
            }],
          })],
        },
      },
    })
  })

  test("prunes stale empty chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let pruneCalls = 0
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats() {
          pruneCalls += 1
          state.chatsById.delete("chat-stale")
          return ["chat-stale"]
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(pruneCalls).toBe(1)
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "sidebar-sub-1",
      snapshot: {
        type: "sidebar",
        data: {
          projectGroups: [{
            ...withSidebarGroupDefaults({
              groupKey: "project-1",
              title: "Project",
              localPath: "/tmp/project",
              chats: [],
            }),
          }],
        },
      },
    })
  })

  test("protects draft-bearing chats during explicit maintenance runs", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-stale", {
      id: "chat-stale",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    let capturedProtectedChatIds: string[] = []
    const router = createWsRouter({
      store: {
        state,
        async pruneStaleEmptyChats(args?: { protectedChatIds?: Iterable<string> }) {
          capturedProtectedChatIds = [...(args?.protectedChatIds ?? [])]
          return []
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "draft-protection-1",
        command: {
          type: "chat.setDraftProtection",
          chatIds: ["chat-stale"],
        },
      })
    )

    await router.pruneStaleEmptyChats()
    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "sidebar-sub-1",
        topic: { type: "sidebar" },
      })
    )

    expect(capturedProtectedChatIds).toEqual(["chat-stale"])
    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "draft-protection-1",
    })
  })

  test("broadcasts background title-generation errors to connected clients", () => {
    let reportBackgroundError: ((message: string) => void) | null | undefined
    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: {
        getActiveStatuses: () => new Map(),
        setBackgroundErrorReporter: (reporter: ((message: string) => void) | null) => {
          reportBackgroundError = reporter
        },
      } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()
    router.handleOpen(ws as never)

    reportBackgroundError?.("[title-generation] chat chat-1 failed")

    expect(ws.sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: "error",
        message: "[title-generation] chat chat-1 failed",
      },
    ])
  })

  test("subscribes to keybindings snapshots and writes keybindings through the router", async () => {
    const initialSnapshot: KeybindingsSnapshot = DEFAULT_KEYBINDINGS_SNAPSHOT
    const keybindings = {
      snapshot: initialSnapshot,
      getSnapshot() {
        return this.snapshot
      },
      onChange: () => () => {},
      async write(bindings: KeybindingsSnapshot["bindings"]) {
        this.snapshot = { bindings, warning: null, filePathDisplay: "~/.kanna/keybindings.json" }
        return this.snapshot
      },
    }

    const router = createWsRouter({
      store: { state: createEmptyState() } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: keybindings as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "keybindings-sub-1",
        topic: { type: "keybindings" },
      })
    )

    expect(ws.sent[0]).toEqual({
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id: "keybindings-sub-1",
      snapshot: {
        type: "keybindings",
        data: keybindings.snapshot,
      },
    })

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "keybindings-write-1",
        command: {
          type: "settings.writeKeybindings",
          bindings: {
            toggleEmbeddedTerminal: ["cmd+k"],
            toggleRightSidebar: ["ctrl+shift+b"],
            openInFinder: ["cmd+shift+g"],
            openInEditor: ["cmd+shift+p"],
            addSplitTerminal: ["cmd+alt+j"],
            jumpToSidebarChat: ["cmd+alt"],
            createChatInCurrentProject: ["cmd+alt+n"],
            openAddProject: ["cmd+alt+o"],
          },
        },
      })
    )

    await Promise.resolve()
    expect(ws.sent[1]).toEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "keybindings-write-1",
      result: {
        bindings: {
          toggleEmbeddedTerminal: ["cmd+k"],
          toggleRightSidebar: ["ctrl+shift+b"],
          openInFinder: ["cmd+shift+g"],
          openInEditor: ["cmd+shift+p"],
          addSplitTerminal: ["cmd+alt+j"],
          jumpToSidebarChat: ["cmd+alt"],
          createChatInCurrentProject: ["cmd+alt+n"],
          openAddProject: ["cmd+alt+o"],
        },
        warning: null,
        filePathDisplay: "~/.kanna/keybindings.json",
      },
    })
  })

  test("routes discard diff file commands through the diff store and rebroadcasts chat snapshots", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const discardCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const diffStore = {
      getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
      refreshSnapshot: async () => false,
      syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
      generateCommitMessage: async () => ({ subject: "", body: "" }),
      commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
      discardFile: async (args: { projectId: string; projectPath: string; path: string }) => {
        discardCalls.push(args)
        return { snapshotChanged: true }
      },
      ignoreFile: async () => ({ snapshotChanged: false }),
    }

    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
        getRecentChatHistory: () => ({ entries: [], hasOlder: false, olderCursor: null }),
      } as never,
      diffStore: diffStore as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    router.handleOpen(ws as never)
    router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "subscribe",
        id: "chat-sub",
        topic: { type: "chat", chatId: "chat-1" },
      })
    )

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "discard-1",
        command: {
          type: "chat.discardDiffFile",
          chatId: "chat-1",
          path: "app.txt",
        },
      })
    )

    expect(discardCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "app.txt",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "discard-1",
      result: { snapshotChanged: true },
    })
  })

  test("routes ignore diff file commands through the diff store", async () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const ignoreCalls: Array<{ projectId: string; projectPath: string; path: string }> = []
    const router = createWsRouter({
      store: {
        state,
        getChat: (chatId: string) => state.chatsById.get(chatId) ?? null,
        getProject: (projectId: string) => state.projectsById.get(projectId) ?? null,
      } as never,
      diffStore: {
        getProjectSnapshot: () => ({ status: "ready" as const, files: [], defaultBranchName: "main", originRepoSlug: "acme/repo", aheadCount: 0, behindCount: 0, lastFetchedAt: undefined }),
        refreshSnapshot: async () => false,
        syncBranch: async () => ({ ok: true as const, action: "fetch" as const, snapshotChanged: false }),
        generateCommitMessage: async () => ({ subject: "", body: "" }),
        commitFiles: async () => ({ ok: true as const, mode: "commit_only" as const, pushed: false, snapshotChanged: false }),
        discardFile: async () => ({ snapshotChanged: false }),
        ignoreFile: async (args: { projectId: string; projectPath: string; path: string }) => {
          ignoreCalls.push(args)
          return { snapshotChanged: false }
        },
      } as never,
      agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set() } as never,
      terminals: {
        getSnapshot: () => null,
        onEvent: () => () => {},
      } as never,
      keybindings: {
        getSnapshot: () => DEFAULT_KEYBINDINGS_SNAPSHOT,
        onChange: () => () => {},
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "Local Machine",
    })
    const ws = new FakeWebSocket()

    await router.handleMessage(
      ws as never,
      JSON.stringify({
        v: 1,
        type: "command",
        id: "ignore-1",
        command: {
          type: "chat.ignoreDiffFile",
          chatId: "chat-1",
          path: "scratch.log",
        },
      })
    )

    expect(ignoreCalls).toEqual([{
      projectId: "project-1",
      projectPath: "/tmp/project",
      path: "scratch.log",
    }])
    expect(ws.sent).toContainEqual({
      v: PROTOCOL_VERSION,
      type: "ack",
      id: "ignore-1",
      result: { snapshotChanged: false },
    })
  })
})
