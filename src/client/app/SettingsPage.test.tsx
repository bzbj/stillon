import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshCw } from "lucide-react"
import { MemoryRouter } from "react-router-dom"
import {
  ChangelogSection,
  getOnboardingCompletedTaskCount,
  ONBOARDING_TASK_COUNT,
  buildSourceUpgradePrompt,
  compareReleaseVersions,
  fetchGithubReleases,
  formatPublishedDate,
  getAvailableSourceRelease,
  getCachedChangelog,
  getKeybindingsSubtitle,
  getMachineNameEditorState,
  loadChangelog,
  resetSettingsPageChangelogCache,
  resolveSettingsSectionId,
  setCachedChangelog,
  shouldPreviewChatSoundChange,
  SkillsSection,
  SubscriptionUsageSection,
  WelcomeChecklist,
} from "./SettingsPage"
import { SettingsHeaderButton } from "../components/ui/settings-header-button"
import type { SubscriptionUsageSnapshot } from "../../shared/types"

const SAMPLE_RELEASES = [
  {
    id: 1,
    name: "v0.8.1",
    tag_name: "v0.8.1",
    html_url: "https://github.com/bzbj/stillon/releases/tag/v0.8.1",
    published_at: "2026-03-19T16:53:08Z",
    body: "## Improvements\n- Better cursor color",
    prerelease: false,
    draft: false,
  },
  {
    id: 2,
    name: null,
    tag_name: "v0.9.0-beta.1",
    html_url: "https://github.com/bzbj/stillon/releases/tag/v0.9.0-beta.1",
    published_at: "2026-03-20T12:00:00Z",
    body: "",
    prerelease: true,
    draft: false,
  },
]

afterEach(() => {
  resetSettingsPageChangelogCache()
})

describe("machine-name editor", () => {
  test("keeps an edit local until it is meaningfully different from the confirmed name", () => {
    expect(getMachineNameEditorState("Office Mac", "Office Mac")).toEqual({
      canSave: false,
      hasUnsavedChanges: false,
    })
    expect(getMachineNameEditorState("Office Mac ", "Office Mac")).toEqual({
      canSave: false,
      hasUnsavedChanges: true,
    })
    expect(getMachineNameEditorState("Studio Mac", "Office Mac")).toEqual({
      canSave: true,
      hasUnsavedChanges: true,
    })
  })

  test("does not offer a save before the confirmed server name is ready", () => {
    expect(getMachineNameEditorState("Studio Mac", null)).toEqual({
      canSave: false,
      hasUnsavedChanges: false,
    })
  })
})

describe("fetchGithubReleases", () => {
  test("filters draft releases and sends the GitHub accept header", async () => {
    let requestedUrl = ""
    let requestedAcceptHeader = ""

    const releases = await fetchGithubReleases(async (input, init) => {
      requestedUrl = String(input)
      requestedAcceptHeader = String(new Headers(init?.headers).get("Accept"))

      return new Response(JSON.stringify([
        SAMPLE_RELEASES[0],
        { ...SAMPLE_RELEASES[1], draft: true },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    expect(requestedUrl).toBe("https://api.github.com/repos/bzbj/stillon/releases")
    expect(requestedAcceptHeader).toBe("application/vnd.github+json")
    expect(releases).toEqual([SAMPLE_RELEASES[0]])
  })

  test("throws on non-200 responses", async () => {
    await expect(fetchGithubReleases(async () => new Response("nope", { status: 403 }))).rejects.toThrow(
      "GitHub releases request failed with status 403"
    )
  })
})

describe("changelog cache", () => {
  test("reuses cached releases inside the ttl window", () => {
    const originalNow = Date.now
    Date.now = () => 1_000

    setCachedChangelog([SAMPLE_RELEASES[0]])
    expect(getCachedChangelog()).toEqual([SAMPLE_RELEASES[0]])

    Date.now = () => 1_000 + 4 * 60 * 1000
    expect(getCachedChangelog()).toEqual([SAMPLE_RELEASES[0]])

    Date.now = originalNow
  })

  test("expires cached releases after the ttl window", () => {
    const originalNow = Date.now
    Date.now = () => 2_000

    setCachedChangelog([SAMPLE_RELEASES[0]])
    Date.now = () => 2_000 + 5 * 60 * 1000 + 1

    expect(getCachedChangelog()).toBeNull()

    Date.now = originalNow
  })

  test("force refresh bypasses the in-memory cache", async () => {
    setCachedChangelog([SAMPLE_RELEASES[0]])

    const releases = await loadChangelog({
      force: true,
      fetchImpl: async () => new Response(JSON.stringify([SAMPLE_RELEASES[1]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    })

    expect(releases).toEqual([SAMPLE_RELEASES[1]])
  })
})

describe("resolveSettingsSectionId", () => {
  test("accepts known settings sections", () => {
    expect(resolveSettingsSectionId("welcome")).toBe("welcome")
    expect(resolveSettingsSectionId("general")).toBe("general")
    expect(resolveSettingsSectionId("network")).toBe("network")
    expect(resolveSettingsSectionId("providers")).toBe("providers")
    expect(resolveSettingsSectionId("changelog")).toBe("changelog")
    expect(resolveSettingsSectionId("keybindings")).toBe("keybindings")
    expect(resolveSettingsSectionId("skills")).toBe("skills")
  })

  test("rejects unknown settings sections", () => {
    expect(resolveSettingsSectionId("page-1")).toBeNull()
    expect(resolveSettingsSectionId("page-2")).toBeNull()
    expect(resolveSettingsSectionId("page-3")).toBeNull()
    expect(resolveSettingsSectionId("nope")).toBeNull()
    expect(resolveSettingsSectionId(undefined)).toBeNull()
  })
})

describe("WelcomeChecklist", () => {
  test("shows independent Codex and Claude tasks in the six-task setup flow", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WelcomeChecklist
          state={{
            appSettings: {},
            connectionStatus: "connected",
            localProjectsReady: true,
            localProjects: { projects: [] },
            machineName: "Lenovo",
            socket: { command: async () => ({ providers: [], generatedAt: 0 }) },
            handleOpenLocalProject: async () => {},
            handleWriteAppSettings: async () => ({}),
            openAddProjectModal: () => {},
          } as never}
        />
      </MemoryRouter>
    )

    expect(html).toContain("1 of 6 ready")
    expect(html).toContain("Connect Codex")
    expect(html).toContain("Connect Claude Code")
    expect(html).toContain("Send a first Codex message")
    expect(html).toContain("Send a first Claude message")
    expect((html.match(/md:grid-cols-2/g) ?? []).length).toBe(2)
  })

  test("counts all six tasks independently", () => {
    const emptyProgress = {
      nameConfirmed: false,
      codexChecked: false,
      claudeChecked: false,
      codexTestConfirmed: false,
      claudeTestConfirmed: false,
    }
    const allCompleteProgress = {
      nameConfirmed: true,
      codexChecked: true,
      claudeChecked: true,
      codexTestConfirmed: true,
      claudeTestConfirmed: true,
    }

    expect(ONBOARDING_TASK_COUNT).toBe(6)
    expect(getOnboardingCompletedTaskCount(emptyProgress, {
      localServiceReady: true,
      codexReady: true,
      claudeReady: true,
    })).toBe(1)
    expect(getOnboardingCompletedTaskCount(allCompleteProgress, {
      localServiceReady: true,
      codexReady: true,
      claudeReady: true,
    })).toBe(6)
    expect(getOnboardingCompletedTaskCount(allCompleteProgress, {
      localServiceReady: true,
      codexReady: false,
      claudeReady: true,
    })).toBe(5)
  })
})

describe("SkillsSection", () => {
  test("renders installed and discover sections", () => {
    const html = renderToStaticMarkup(
      <SkillsSection
        state={{
          connectionStatus: "connected",
          socket: {
            command: async () => ({ skills: [] }),
          } as never,
        }}
      />
    )

    expect(html).toContain("Installed")
    expect(html).toContain("Discover")
    expect(html).toContain("Search skills")
  })
})

describe("SubscriptionUsageSection", () => {
  test("renders the Fable 5 model-scoped weekly limit", () => {
    const snapshot: SubscriptionUsageSnapshot = {
      generatedAt: 1_783_000_000_000,
      providers: [
        {
          provider: "claude",
          label: "Claude Code",
          status: "available",
          planType: "pro",
          accountEmail: "claude@example.com",
          source: "Claude Agent SDK /usage",
          updatedAt: 1_783_000_000_000,
          error: null,
          windows: [
            {
              id: "five_hour",
              label: "5-hour window",
              usedPercent: 12,
              windowMinutes: 300,
              resetsAt: 1_783_001_000_000,
              resetsAtText: null,
            },
            {
              id: "weekly",
              label: "Weekly window",
              usedPercent: 25,
              windowMinutes: 10_080,
              resetsAt: 1_783_600_000_000,
              resetsAtText: null,
            },
            {
              id: "fable_weekly",
              label: "Fable 5 limit",
              usedPercent: 42,
              windowMinutes: 10_080,
              resetsAt: 1_783_600_000_000,
              resetsAtText: null,
            },
          ],
        },
      ],
    }

    const html = renderToStaticMarkup(
      <SubscriptionUsageSection snapshot={snapshot} status="success" error={null} onRetry={() => {}} />
    )

    expect(html).toContain("Fable 5 limit")
    expect(html).toContain("42%")
    expect(html).toContain("lg:grid-cols-3")
  })
})

describe("getKeybindingsSubtitle", () => {
  test("renders the active keybindings path", () => {
    expect(getKeybindingsSubtitle("~/.kanna-dev/keybindings.json")).toBe(
      "Edit global app shortcuts stored in ~/.kanna-dev/keybindings.json."
    )
  })
})

describe("shouldPreviewChatSoundChange", () => {
  test("previews only when the selected value actually changes", () => {
    expect(shouldPreviewChatSoundChange("always", "always")).toBe(false)
    expect(shouldPreviewChatSoundChange("always", "never")).toBe(true)
    expect(shouldPreviewChatSoundChange("never", "unfocused")).toBe(true)
    expect(shouldPreviewChatSoundChange("funk", "glass")).toBe(true)
  })
})

describe("SettingsHeaderButton", () => {
  test("renders shared header button content and icon", () => {
    const html = renderToStaticMarkup(
      <SettingsHeaderButton icon={<RefreshCw className="size-3.5" />}>
        Refresh
      </SettingsHeaderButton>
    )

    expect(html).toContain("Refresh")
    expect(html).toContain("lucide-refresh-cw")
    expect(html).toContain("gap-1.5")
  })

  test("supports the default variant", () => {
    const html = renderToStaticMarkup(
      <SettingsHeaderButton variant="default" >
        Update
      </SettingsHeaderButton>
    )

    expect(html).toContain("Update")
    expect(html).toContain("bg-primary")
  })
})

describe("ChangelogSection", () => {
  test("renders release cards, markdown, links, and prerelease badges", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        currentVersion="0.8.1"
      />
    )

    expect(html).not.toContain("You are currently running this version of StillOn.")
    expect(html).toContain("Current")
    expect(html).toContain("v0.8.1")
    expect(html).toContain("Better cursor color")
    expect(html).toContain('aria-label="View release on GitHub"')
    expect(html).toContain("https://github.com/bzbj/stillon/releases/tag/v0.8.1")
    expect(html).toContain("Prerelease")
    expect(html).toContain("No release notes were provided.")
    expect(html).toContain(formatPublishedDate("2026-03-19T16:53:08Z"))
    expect(html).not.toContain("View on GitHub")
  })

  test("renders an error state with retry action", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="error"
        releases={[]}
        error="GitHub said no"
        onRetry={() => {}}
        currentVersion="1.0.0"
      />
    )

    expect(html).toContain("Could not load changelog")
    expect(html).toContain("GitHub said no")
    expect(html).toContain("Retry")
  })

  test("does not render an install action", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        currentVersion="1.0.0"
      />
    )

    expect(html).not.toContain(">Update<")
  })

  test("offers a coding-agent prompt only when a newer stable release exists", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={[
          ...SAMPLE_RELEASES,
          {
            ...SAMPLE_RELEASES[0],
            id: 3,
            name: "v0.8.2",
            tag_name: "v0.8.2",
            html_url: "https://github.com/bzbj/stillon/releases/tag/v0.8.2",
          },
        ]}
        error={null}
        onRetry={() => {}}
        currentVersion="0.8.1"
      />
    )

    expect(html).toContain("Upgrade available: v0.8.2")
    expect(html).toContain("Generate upgrade prompt")
    expect(html).toContain("StillOn will not install it automatically.")
    expect(html).not.toContain("npm install")
  })

  test("does not offer a prompt for a prerelease or current release", () => {
    const html = renderToStaticMarkup(
      <ChangelogSection
        status="success"
        releases={SAMPLE_RELEASES}
        error={null}
        onRetry={() => {}}
        currentVersion="0.8.1"
      />
    )

    expect(html).not.toContain("Generate upgrade prompt")
  })
})

describe("source release upgrades", () => {
  test("compares semantic versions without relying on release feed order", () => {
    expect(compareReleaseVersions("v0.10.0", "0.9.9")).toBe(1)
    expect(compareReleaseVersions("1.0.0-rc.1", "1.0.0")).toBe(-1)
    expect(compareReleaseVersions("not-a-version", "1.0.0")).toBeNull()

    expect(getAvailableSourceRelease([
      { ...SAMPLE_RELEASES[0], id: 4, tag_name: "v0.9.0", prerelease: false },
      { ...SAMPLE_RELEASES[0], id: 5, tag_name: "v0.10.0", prerelease: false },
      { ...SAMPLE_RELEASES[1], id: 6, tag_name: "v0.11.0-beta.1", prerelease: true },
    ], "0.8.1")?.tag_name).toBe("v0.10.0")
  })

  test("builds a safe Bun source-upgrade prompt", () => {
    const prompt = buildSourceUpgradePrompt("0.8.1", {
      tag_name: "v0.8.2",
      html_url: "https://github.com/bzbj/stillon/releases/tag/v0.8.2",
    })

    expect(prompt).toContain("从 v0.8.1 升级到 GitHub Release v0.8.2")
    expect(prompt).toContain("checkout --detach v0.8.2")
    expect(prompt).toContain("bun install --frozen-lockfile")
    expect(prompt).toContain("不要使用 npm、npx")
    expect(prompt).toContain("bun install -g")
  })
})
