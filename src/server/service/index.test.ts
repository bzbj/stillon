import { describe, expect, test } from "bun:test"
import { createServiceLaunchSpec, manageService, resolveServiceBackend, runServiceCommand } from "."
import type { ServiceAction, ServiceBackend, ServiceBackendContext } from "./types"

describe("createServiceLaunchSpec", () => {
  test("builds a fixed-port non-interactive service invocation", () => {
    expect(createServiceLaunchSpec({
      executable: "/opt/bun/bin/bun",
      entrypoint: "/opt/stillon/bin/stillon",
      workingDirectory: "/srv/stillon",
      homeDirectory: "/home/alice",
      pathEnvironment: "/opt/bun/bin:/usr/bin",
      port: 4000,
      environmentFile: "/etc/stillon/production.env",
    })).toEqual({
      executable: "/opt/bun/bin/bun",
      args: ["--env-file", "/etc/stillon/production.env", "/opt/stillon/bin/stillon", "--no-open", "--strict-port", "--port", "4000"],
      workingDirectory: "/srv/stillon",
      homeDirectory: "/home/alice",
      pathEnvironment: "/opt/bun/bin:/usr/bin",
      environmentFile: "/etc/stillon/production.env",
      localAppDataDirectory: undefined,
    })
  })

  test("rejects invalid ports", () => {
    expect(() => createServiceLaunchSpec({ entrypoint: "/stillon", port: 0 })).toThrow("Invalid service port")
    expect(() => createServiceLaunchSpec({ entrypoint: "/stillon", port: 70000 })).toThrow("Invalid service port")
  })

  test("uses the runtime root as the durable default working directory", () => {
    const launch = createServiceLaunchSpec({
      executable: "/opt/bun/bin/bun",
      entrypoint: "/opt/stillon/bin/stillon",
      homeDirectory: "/home/alice",
    })

    expect(launch.workingDirectory).toBe("/opt/stillon")
  })

  test("rejects an empty environment file path", () => {
    expect(() => createServiceLaunchSpec({ entrypoint: "/stillon", environmentFile: "  " }))
      .toThrow("Service environment file path cannot be empty")
  })
})

describe("manageService", () => {
  test("dispatches the requested action to the selected backend", async () => {
    const calls: ServiceAction[] = []
    const record = (action: ServiceAction) => async (_context: ServiceBackendContext) => {
      calls.push(action)
    }
    const backend: ServiceBackend = {
      install: record("install"),
      status: record("status"),
      logs: record("logs"),
      uninstall: record("uninstall"),
    }

    await manageService("status", {
      backend,
      entrypoint: "/stillon",
      homeDirectory: "/home/alice",
    })

    expect(calls).toEqual(["status"])
  })
})

describe("resolveServiceBackend", () => {
  test("rejects unsupported platforms", () => {
    expect(() => resolveServiceBackend("aix")).toThrow("not supported on aix")
  })
})

describe("runServiceCommand", () => {
  test("captures stdout, stderr, and exit code without a shell", async () => {
    const result = await runServiceCommand(process.execPath, [
      "--eval",
      "console.log('out'); console.error('err'); process.exit(3)",
    ])

    expect(result).toMatchObject({ code: 3, signal: null, stdout: "out\n", stderr: "err\n" })
  })
})
