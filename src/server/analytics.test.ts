import { describe, expect, test } from "bun:test"
import { StillOnAnalyticsReporter, getLaunchAnalyticsProperties } from "./analytics"

const originalLogAnalytics = process.env.STILLON_LOG_ANALYTICS

function restoreAnalyticsLoggingEnv() {
  if (originalLogAnalytics === undefined) {
    delete process.env.STILLON_LOG_ANALYTICS
    return
  }
  process.env.STILLON_LOG_ANALYTICS = originalLogAnalytics
}

describe("getLaunchAnalyticsProperties", () => {
  test("expands launch flags into app_launch properties", () => {
    expect(getLaunchAnalyticsProperties({
      port: 4000,
      host: "0.0.0.0",
      openBrowser: false,
      password: "secret",
      strictPort: true,
    })).toEqual({
      custom_port_enabled: true,
      no_open_enabled: true,
      password_enabled: true,
      strict_port_enabled: true,
      remote_enabled: true,
      host_enabled: false,
    })
  })
})

describe("StillOnAnalyticsReporter", () => {
  test("posts the userId, event name, and shared properties", async () => {
    const originalLog = console.log
    const calls: Array<{ url: string; init?: RequestInit }> = []
    console.log = () => {}

    try {
      const reporter = new StillOnAnalyticsReporter({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        settings: {
          getState: () => ({
            analyticsEnabled: true,
            analyticsUserId: "anon_123",
            warning: null,
            filePathDisplay: "~/.stillon/data/settings.json",
          }),
        },
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })

      reporter.track("message_sent")
      await (reporter as any).queue

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe("https://kanna.sh/api/t")
      expect(calls[0]?.init?.method).toBe("POST")
      expect(calls[0]?.init?.headers).toEqual({
        "content-type": "application/json",
      })
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        userId: "anon_123",
        environment: "dev",
        event: {
          name: "message_sent",
          properties: {
            current_version: "0.33.9",
            environment: "dev",
          },
        },
      })
    } finally {
      console.log = originalLog
    }
  })

  test("posts app_launch with launch flags as properties", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const reporter = new StillOnAnalyticsReporter({
      endpoint: "https://kanna.sh/api/t",
      currentVersion: "0.33.9",
      environment: "prod",
      settings: {
        getState: () => ({
          analyticsEnabled: true,
          analyticsUserId: "anon_123",
          warning: null,
          filePathDisplay: "~/.stillon/data/settings.json",
        }),
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })

    reporter.trackLaunch({
      port: 4000,
      host: "localhost",
      openBrowser: false,
      password: null,
      strictPort: true,
    })
    await (reporter as any).queue

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      userId: "anon_123",
      environment: "prod",
      event: {
        name: "app_launch",
        properties: {
          current_version: "0.33.9",
          environment: "prod",
          custom_port_enabled: true,
          no_open_enabled: true,
          password_enabled: false,
          strict_port_enabled: true,
          remote_enabled: false,
          host_enabled: false,
        },
      },
    })
  })

  test("skips requests when analytics is disabled", async () => {
    let called = false
    const reporter = new StillOnAnalyticsReporter({
      currentVersion: "0.33.9",
      environment: "prod",
      settings: {
        getState: () => ({
          analyticsEnabled: false,
          analyticsUserId: "anon_123",
          warning: null,
          filePathDisplay: "~/.stillon/data/settings.json",
        }),
      },
      fetchImpl: async () => {
        called = true
        return new Response(null, { status: 200 })
      },
    })

    reporter.track("message_sent")
    await (reporter as any).queue

    expect(called).toBe(false)
  })

  test("does not warn when analytics request logging is disabled and the request fails", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    delete process.env.STILLON_LOG_ANALYTICS

    try {
      const reporter = new StillOnAnalyticsReporter({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        settings: {
          getState: () => ({
            analyticsEnabled: true,
            analyticsUserId: "anon_123",
            warning: null,
            filePathDisplay: "~/.stillon/data/settings.json",
          }),
        },
        fetchImpl: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      })

      reporter.track("message_sent")
      await (reporter as any).queue

      expect(warnings).toHaveLength(0)
    } finally {
      console.warn = originalWarn
      restoreAnalyticsLoggingEnv()
    }
  })

  test("warns when analytics request logging is enabled and the request fails", async () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    process.env.STILLON_LOG_ANALYTICS = "1"

    try {
      const reporter = new StillOnAnalyticsReporter({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "prod",
        settings: {
          getState: () => ({
            analyticsEnabled: true,
            analyticsUserId: "anon_123",
            warning: null,
            filePathDisplay: "~/.stillon/data/settings.json",
          }),
        },
        fetchImpl: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
      })

      reporter.track("message_sent")
      await (reporter as any).queue

      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.[0]).toBe("[stillon/analytics] Failed to send analytics event:")
      expect(warnings[0]?.[1]).toBe("message_sent")
      expect(warnings[0]?.[2]).toBeInstanceOf(Error)
    } finally {
      console.warn = originalWarn
      restoreAnalyticsLoggingEnv()
    }
  })

  test("logs when analytics request logging is enabled and the request succeeds", async () => {
    const originalLog = console.log
    const logs: unknown[][] = []
    console.log = (...args: unknown[]) => {
      logs.push(args)
    }
    process.env.STILLON_LOG_ANALYTICS = "1"

    try {
      const reporter = new StillOnAnalyticsReporter({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "dev",
        settings: {
          getState: () => ({
            analyticsEnabled: true,
            analyticsUserId: "anon_123",
            warning: null,
            filePathDisplay: "~/.stillon/data/settings.json",
          }),
        },
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      })

      reporter.track("message_sent")
      await (reporter as any).queue

      expect(logs).toHaveLength(1)
      expect(logs[0]).toEqual([
        "[stillon/analytics] Sent analytics event:",
        "message_sent",
        200,
      ])
    } finally {
      console.log = originalLog
      restoreAnalyticsLoggingEnv()
    }
  })

  test("does not log when analytics request logging is disabled and the request succeeds", async () => {
    const originalLog = console.log
    const logs: unknown[][] = []
    console.log = (...args: unknown[]) => {
      logs.push(args)
    }
    delete process.env.STILLON_LOG_ANALYTICS

    try {
      const reporter = new StillOnAnalyticsReporter({
        endpoint: "https://kanna.sh/api/t",
        currentVersion: "0.33.9",
        environment: "prod",
        settings: {
          getState: () => ({
            analyticsEnabled: true,
            analyticsUserId: "anon_123",
            warning: null,
            filePathDisplay: "~/.stillon/data/settings.json",
          }),
        },
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      })

      reporter.track("message_sent")
      await (reporter as any).queue

      expect(logs).toHaveLength(0)
    } finally {
      console.log = originalLog
      restoreAnalyticsLoggingEnv()
    }
  })
})
