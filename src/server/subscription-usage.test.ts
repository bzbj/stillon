import { describe, expect, test } from "bun:test"
import {
  getClaudeCliCommand,
  parseClaudeResetAtText,
  parseClaudeUsageResult,
  parseCodexAppServerSnapshot,
  readSubscriptionUsageSnapshot,
} from "./subscription-usage"

describe("subscription usage", () => {
  test("parses Codex app-server rate limits from the general codex bucket", () => {
    const now = new Date(2026, 5, 30, 17, 30).getTime()
    const provider = parseCodexAppServerSnapshot(
      {
        account: {
          email: "codex@example.com",
          planType: "plus",
        },
      },
      {
        rateLimits: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          planType: "pro",
          primary: {
            usedPercent: 0,
            windowDurationMins: 300,
            resetsAt: 1_782_844_181,
          },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10_080,
            resetsAt: 1_783_430_910,
          },
        },
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            primary: { usedPercent: 0 },
            secondary: { usedPercent: 0 },
          },
          codex: {
            limitId: "codex",
            planType: "pro",
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: 1_782_840_892,
            },
            secondary: {
              usedPercent: 9,
              windowDurationMins: 10_080,
              resetsAt: 1_783_388_762,
            },
          },
        },
      },
      now
    )

    expect(provider).toMatchObject({
      provider: "codex",
      status: "available",
      planType: "plus",
      accountEmail: "codex@example.com",
      source: "codex app-server account/rateLimits/read",
      updatedAt: now,
      windows: [
        { id: "five_hour", usedPercent: 10, windowMinutes: 300 },
        { id: "weekly", usedPercent: 9, windowMinutes: 10_080 },
      ],
    })
    expect(provider.windows[0]?.resetsAt).toBe(1_782_840_892_000)
  })

  test("leaves the five-hour window unavailable when Codex returns only a weekly primary limit", () => {
    const now = new Date(2026, 6, 13, 12, 0).getTime()
    const provider = parseCodexAppServerSnapshot(
      {
        account: {
          email: "codex@example.com",
          planType: "pro",
        },
      },
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            planType: "pro",
            primary: {
              usedPercent: 4,
              windowDurationMins: 10_080,
              resetsAt: 1_784_516_803,
            },
            secondary: null,
          },
        },
      },
      now
    )

    expect(provider).toMatchObject({
      provider: "codex",
      status: "available",
      planType: "pro",
      windows: [
        { id: "five_hour", usedPercent: null, windowMinutes: 300, resetsAt: null },
        { id: "weekly", usedPercent: 4, windowMinutes: 10_080 },
      ],
    })
    expect(provider.windows[1]?.resetsAt).toBe(1_784_516_803_000)
  })

  test("parses Claude usage text into 5-hour and weekly windows", () => {
    const now = new Date(2026, 5, 30, 17, 30).getTime()
    const windows = parseClaudeUsageResult(
      [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current session: 0% used · resets Jun 30 at 9:29pm (Asia/Shanghai)",
        "Current week (all models): 5% used · resets Jul 1 at 4:59am (Asia/Shanghai)",
      ].join("\n"),
      now
    )

    expect(windows[0]).toMatchObject({
      id: "five_hour",
      usedPercent: 0,
      resetsAtText: "Jun 30 at 9:29pm (Asia/Shanghai)",
    })
    expect(windows[0]?.resetsAt).toBe(new Date(2026, 5, 30, 21, 29).getTime())
    expect(windows[1]).toMatchObject({
      id: "weekly",
      usedPercent: 5,
      resetsAtText: "Jul 1 at 4:59am (Asia/Shanghai)",
    })
    expect(windows[1]?.resetsAt).toBe(new Date(2026, 6, 1, 4, 59).getTime())
  })

  test("keeps Claude reset dates in the next year when month/day already passed", () => {
    const now = new Date(2026, 11, 31, 23, 0).getTime()
    expect(parseClaudeResetAtText("Jan 1 at 1:15am (Asia/Shanghai)", now)).toBe(
      new Date(2027, 0, 1, 1, 15).getTime()
    )
  })

  test("reads Codex app-server and Claude usage into one settings snapshot", async () => {
    const snapshot = await readSubscriptionUsageSnapshot({
      now: new Date(2026, 5, 30, 17, 30).getTime(),
      readCodexAppServer: async () => ({
        account: {
          account: {
            email: "codex@example.com",
            planType: "plus",
          },
        },
        rateLimits: {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              planType: "pro",
              primary: {
                usedPercent: 18,
                windowDurationMins: 300,
                resetsAt: 1_782_808_000,
              },
              secondary: {
                usedPercent: 4,
                windowDurationMins: 10_080,
                resetsAt: 1_783_000_000,
              },
            },
          },
        },
      }),
      readClaudeSdkUsage: async () => ({
        subscriptionType: "pro",
        accountEmail: "claude@example.com",
        rateLimitsAvailable: true,
        fiveHour: {
          utilization: 0,
          resetsAt: "2026-06-30T13:29:00.000Z",
        },
        weekly: {
          utilization: 5,
          resetsAt: "2026-06-30T20:59:00.000Z",
        },
        modelScoped: [
          {
            displayName: "Fable",
            utilization: 42,
            resetsAt: "2026-06-30T20:59:00.000Z",
          },
        ],
      }),
    })

    expect(snapshot.providers[0]).toMatchObject({
      provider: "codex",
      status: "available",
      planType: "plus",
      accountEmail: "codex@example.com",
      windows: [
        { id: "five_hour", usedPercent: 18 },
        { id: "weekly", usedPercent: 4 },
      ],
    })
    expect(snapshot.providers[1]).toMatchObject({
      provider: "claude",
      status: "available",
      planType: "pro",
      accountEmail: "claude@example.com",
      windows: [
        { id: "five_hour", usedPercent: 0 },
        { id: "weekly", usedPercent: 5 },
        { id: "fable_weekly", label: "Fable 5 limit", usedPercent: 42 },
      ],
    })
  })

  test("falls back to Claude CLI usage when the SDK usage API is unavailable", async () => {
    const snapshot = await readSubscriptionUsageSnapshot({
      now: new Date(2026, 5, 30, 17, 30).getTime(),
      readCodexAppServer: async () => ({ account: {}, rateLimits: {} }),
      readClaudeSdkUsage: async () => {
        throw new Error("get_usage is not supported")
      },
      runCommand: async (_command, args) => {
        if (args[0] === "auth") {
          return {
            stdout: JSON.stringify({ subscriptionType: "pro", email: "claude@example.com" }),
            stderr: "",
          }
        }
        return {
          stdout: JSON.stringify({
            result: [
              "Current session: 3% used · resets Jun 30 at 9:29pm (Asia/Shanghai)",
              "Current week (all models): 11% used · resets Jul 1 at 4:59am (Asia/Shanghai)",
            ].join("\n"),
          }),
          stderr: "",
        }
      },
    })

    expect(snapshot.providers[1]).toMatchObject({
      provider: "claude",
      status: "available",
      source: "claude /usage",
      planType: "pro",
      accountEmail: "claude@example.com",
      windows: [
        { id: "five_hour", usedPercent: 3 },
        { id: "weekly", usedPercent: 11 },
      ],
    })
  })

  test("uses the Windows command shim for Claude Code", () => {
    expect(getClaudeCliCommand("win32")).toBe("claude.cmd")
    expect(getClaudeCliCommand("darwin")).toBe("claude")
  })
})
