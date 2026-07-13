import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { compareVersions, classifyInstallVersionFailure, parseArgs, runCli } from "./cli-runtime"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"

const originalRuntimeProfile = process.env.STILLON_RUNTIME_PROFILE
const originalSuppressOpen = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
const originalStillOnTrustProxy = process.env.STILLON_TRUST_PROXY
const originalStillOnDisableSelfUpdate = process.env.STILLON_DISABLE_SELF_UPDATE

beforeEach(() => {
  delete process.env.STILLON_DISABLE_SELF_UPDATE
  delete process.env.STILLON_TRUST_PROXY
})

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.STILLON_RUNTIME_PROFILE
  } else {
    process.env.STILLON_RUNTIME_PROFILE = originalRuntimeProfile
  }
  if (originalSuppressOpen === undefined) {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
  } else {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = originalSuppressOpen
  }
  if (originalStillOnTrustProxy === undefined) {
    delete process.env.STILLON_TRUST_PROXY
  } else {
    process.env.STILLON_TRUST_PROXY = originalStillOnTrustProxy
  }
  if (originalStillOnDisableSelfUpdate === undefined) {
    delete process.env.STILLON_DISABLE_SELF_UPDATE
  } else {
    process.env.STILLON_DISABLE_SELF_UPDATE = originalStillOnDisableSelfUpdate
  }
})

function createDeps(overrides: Partial<Parameters<typeof runCli>[1]> = {}) {
  const calls = {
    startServer: [] as Array<{
      port: number
      host: string
      openBrowser: boolean
      password: string | null
      strictPort: boolean
      trustProxy?: boolean
      update?: {
        version: string
        argv: string[]
        command: string
      }
    }>,
    fetchLatestVersion: [] as string[],
    installVersion: [] as Array<{ packageName: string; version: string }>,
    openUrl: [] as string[],
    log: [] as string[],
    warn: [] as string[],
    manageService: [] as Array<{
      action: "install" | "status" | "logs" | "uninstall"
      port: number
      environmentFile?: string
      host?: string
      trustProxy?: boolean
    }>,
  }

  const deps: Parameters<typeof runCli>[1] = {
    version: "0.3.0",
    bunVersion: "1.3.10",
    startServer: async (options) => {
      calls.startServer.push(options)
      return {
        port: options.port,
        stop: async () => {},
      }
    },
    fetchLatestVersion: async (packageName) => {
      calls.fetchLatestVersion.push(packageName)
      return "0.3.0"
    },
    installVersion: (packageName, version) => {
      calls.installVersion.push({ packageName, version })
      return {
        ok: true,
        errorCode: null,
        userTitle: null,
        userMessage: null,
      }
    },
    openUrl: (url) => {
      calls.openUrl.push(url)
    },
    log: (message) => {
      calls.log.push(message)
    },
    warn: (message) => {
      calls.warn.push(message)
    },
    manageService: async (action, options) => {
      calls.manageService.push({ action, ...options })
    },
    ...overrides,
  }

  return { calls, deps }
}

describe("parseArgs", () => {
  test("parses runtime options", () => {
    expect(parseArgs(["--port", "4000", "--no-open"])).toEqual({
      kind: "run",
      options: {
        port: 4000,
        host: "127.0.0.1",
        openBrowser: false,
        password: null,
        strictPort: false,
      },
    })
  })

  test("parses strict port and trusted-proxy modes", () => {
    expect(parseArgs(["--strict-port", "--trust-proxy"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        password: null,
        strictPort: true,
      },
      trustProxy: true,
    })
  })

  test("--remote without a value binds all interfaces", () => {
    expect(parseArgs(["--remote"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "0.0.0.0",
        openBrowser: true,
        password: null,
        strictPort: false,
      },
    })
  })

  test("accepts any non-empty password, including a one-character value", () => {
    expect(parseArgs(["--password", "x"])).toEqual({
      kind: "run",
      options: {
        port: 3210,
        host: "127.0.0.1",
        openBrowser: true,
        password: "x",
        strictPort: false,
      },
    })
    expect(parseArgs(["--password=-"])).toMatchObject({
      kind: "run",
      options: { password: "-" },
    })
  })

  test("rejects an empty or missing password", () => {
    expect(() => parseArgs(["--password"])).toThrow("Missing value for --password")
    expect(() => parseArgs(["--password", "--no-open"])).toThrow("Missing value for --password")
    expect(() => parseArgs(["--password="])).toThrow("Missing value for --password")
  })

  test("rejects product-owned tunnel flags with a migration path", () => {
    expect(() => parseArgs(["--share"])).toThrow("--share is no longer built in")
    expect(() => parseArgs(["--cloudflared", "secret-token"])).toThrow("--cloudflared is no longer built in")
  })

  test("--host accepts IPs, hostnames, and inline values", () => {
    expect(parseArgs(["--host", "100.64.0.1"])).toMatchObject({
      kind: "run",
      options: { host: "100.64.0.1" },
    })
    expect(parseArgs(["--host=dev-box"])).toMatchObject({
      kind: "run",
      options: { host: "dev-box" },
    })
  })

  test("--host without a value throws", () => {
    expect(() => parseArgs(["--host"])).toThrow("Missing value for --host")
    expect(() => parseArgs(["--host", "--no-open"])).toThrow("Missing value for --host")
  })

  test("returns version and help actions without running startup", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" })
    expect(parseArgs(["--help"])).toEqual({ kind: "help" })
  })

  test("parses native background service actions", () => {
    expect(parseArgs(["service", "install"])).toEqual({
      kind: "service",
      action: "install",
      options: { port: 3210 },
    })
    expect(parseArgs(["service", "install", "--port=4000", "--host", "100.64.0.1", "--trust-proxy"])).toEqual({
      kind: "service",
      action: "install",
      options: { port: 4000, host: "100.64.0.1", trustProxy: true },
    })
    expect(parseArgs(["service", "install", "--remote"])).toEqual({
      kind: "service",
      action: "install",
      options: { port: 3210, host: "0.0.0.0" },
    })
    expect(parseArgs(["service", "install", "--env-file", "/etc/stillon/production.env"])).toEqual({
      kind: "service",
      action: "install",
      options: { port: 3210, environmentFile: "/etc/stillon/production.env" },
    })
    expect(parseArgs(["service", "status"])).toEqual({
      kind: "service",
      action: "status",
      options: { port: 3210 },
    })
  })

  test("rejects invalid background service commands", () => {
    expect(() => parseArgs(["service"])).toThrow("Missing service action")
    expect(() => parseArgs(["service", "restart"])).toThrow("Unknown service action")
    expect(() => parseArgs(["service", "status", "--port", "4000"])).toThrow("Unexpected argument")
    expect(() => parseArgs(["service", "install", "--port", "0"])).toThrow("Invalid service port")
    expect(() => parseArgs(["service", "install", "--env-file"])).toThrow("Missing value for --env-file")
    expect(() => parseArgs(["service", "install", "--share"])).toThrow("--share is no longer built in")
  })
})

describe("compareVersions", () => {
  test("orders semver-like versions", () => {
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0)
    expect(compareVersions("0.3.0", "0.3.1")).toBe(-1)
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1)
  })
})

describe("classifyInstallVersionFailure", () => {
  test("maps version propagation failures to a user-facing retry message", () => {
    expect(classifyInstallVersionFailure('error: No version matching "0.13.3" found for specifier "@bzbj/stillon"')).toEqual({
      ok: false,
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
      userMessage: "This update is still propagating. Try again in a few minutes.",
    })
  })
})

describe("runCli", () => {
  test("runs service management without checking updates or starting the server", async () => {
    const { calls, deps } = createDeps()

    const result = await runCli(["service", "install", "--port", "4000", "--env-file", "/etc/stillon/production.env"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.manageService).toEqual([{ action: "install", port: 4000, environmentFile: "/etc/stillon/production.env" }])
    expect(calls.fetchLatestVersion).toEqual([])
    expect(calls.startServer).toEqual([])
  })

  test("reports service management failures", async () => {
    const { calls, deps } = createDeps({
      manageService: async () => {
        throw new Error("native service failed")
      },
    })

    const result = await runCli(["service", "status"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.warn).toContain("[stillon] native service failed")
    expect(calls.startServer).toEqual([])
  })

  test("skips update checks for --version", async () => {
    const { calls, deps } = createDeps()

    const result = await runCli(["--version"], deps)

    expect(result).toEqual({ kind: "exited", code: 0 })
    expect(calls.fetchLatestVersion).toEqual([])
    expect(calls.startServer).toEqual([])
    expect(calls.log).toEqual(["0.3.0"])
  })

  test("starts normally when no newer version exists", async () => {
    const { calls, deps } = createDeps()
    process.env.STILLON_RUNTIME_PROFILE = "prod"

    const result = await runCli(["--port", "4000", "--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.fetchLatestVersion).toEqual(["@bzbj/stillon"])
    expect(calls.installVersion).toEqual([])
    expect(calls.startServer).toHaveLength(1)
    expect(calls.startServer[0]).toMatchObject({
      port: 4000,
      host: "127.0.0.1",
      openBrowser: false,
      password: null,
      strictPort: false,
      trustProxy: false,
      update: {
        version: "0.3.0",
        argv: ["--port", "4000", "--no-open"],
        command: "stillon",
      },
    })
    expect(calls.openUrl).toEqual([])
    expect(calls.log).toContain("[stillon] data dir: ~/.stillon/data")
  })

  test("logs the dev data dir when the dev runtime profile is active", async () => {
    process.env.STILLON_RUNTIME_PROFILE = "dev"
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000", "--no-open"], deps)

    expect(calls.log).toContain("[stillon] data dir: ~/.stillon-dev/data")
  })

  test("honors STILLON_TRUST_PROXY for externally managed reverse proxies", async () => {
    process.env.STILLON_TRUST_PROXY = "1"
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000", "--no-open"], deps)

    expect(calls.startServer[0]?.trustProxy).toBe(true)
  })

  test("fails fast on unsupported Bun versions", async () => {
    const { calls, deps } = createDeps({
      bunVersion: "1.3.1",
    })

    const result = await runCli(["--no-open"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn).toContain("[stillon] Bun 1.3.5+ is required for the embedded terminal. Current Bun: 1.3.1")
  })

  test("opens the root route in the browser", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://localhost:4000"])
  })

  test("opens browser at hostname when --host <host> is given", async () => {
    delete process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]
    const { calls, deps } = createDeps()

    await runCli(["--host", "dev-box", "--port", "4000"], deps)

    expect(calls.openUrl).toEqual(["http://dev-box:4000"])
  })

  test("suppresses browser open for a ui-triggered restarted child", async () => {
    process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] = "1"
    const { calls, deps } = createDeps()

    await runCli(["--port", "4000"], deps)

    expect(calls.openUrl).toEqual([])
  })

  test("passes --trust-proxy to the local server", async () => {
    const { calls, deps } = createDeps()

    await runCli(["--trust-proxy", "--port", "4000", "--no-open"], deps)

    expect(calls.startServer[0]?.trustProxy).toBe(true)
  })

  test("reports removed tunnel flags cleanly without starting the server", async () => {
    const { calls, deps } = createDeps()

    const result = await runCli(["--share"], deps)

    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(calls.startServer).toEqual([])
    expect(calls.warn).toContain("[stillon] --share is no longer built in. Use a separately managed reverse proxy or tunnel, or --host/--remote for direct listening.")
  })

  test("warns when a trusted proxy shares a non-loopback listener with direct clients", async () => {
    const { calls, deps } = createDeps()

    await runCli(["--remote", "--trust-proxy", "--no-open"], deps)

    expect(calls.warn).toContain("[stillon] --trust-proxy is active on a non-loopback listener. Restrict the port so only the trusted proxy can reach it; direct clients can forge forwarded headers.")
    expect(calls.warn).toContain("[stillon] this listener is not loopback-only and has no application password. Protect it with an appropriate ingress authentication policy.")
  })

  test("returns restarting when a newer version is available", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      },
    })

    const result = await runCli(["--port", "4000", "--no-open"], deps)

    expect(result).toEqual({ kind: "restarting", reason: "startup_update" })
    expect(calls.installVersion).toEqual([{ packageName: "@bzbj/stillon", version: "0.4.0" }])
    expect(calls.startServer).toEqual([])
  })

  test("falls back to current version when install fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        return "0.4.0"
      },
      installVersion: (packageName, version) => {
        calls.installVersion.push({ packageName, version })
        return {
          ok: false,
          errorCode: "install_failed",
          userTitle: "Update failed",
          userMessage: "StillOn could not install the update. Try again later.",
        }
      },
    })

    const result = await runCli(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([{ packageName: "@bzbj/stillon", version: "0.4.0" }])
    expect(calls.warn).toContain("[stillon] update failed, continuing current version")
  })

  test("falls back to current version when the registry check fails", async () => {
    const { calls, deps } = createDeps({
      fetchLatestVersion: async (packageName) => {
        calls.fetchLatestVersion.push(packageName)
        throw new Error("network unavailable")
      },
    })

    const result = await runCli(["--no-open"], deps)

    expect(result.kind).toBe("started")
    expect(calls.installVersion).toEqual([])
    expect(calls.warn).toContain("[stillon] update check failed, continuing current version")
  })
})
