import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  assertReadableServiceEnvironmentFile,
  createServiceLaunchSpec,
  manageService,
  resolveServiceBackend,
  runServiceCommand,
} from "."
import type { ServiceAction, ServiceBackend, ServiceBackendContext } from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-service-env-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("createServiceLaunchSpec", () => {
  test("builds a fixed-port non-interactive service invocation", () => {
    expect(createServiceLaunchSpec({
      platform: "linux",
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
      platform: "linux",
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

  test("persists explicit external-listener and trusted-proxy options without a password", () => {
    const launch = createServiceLaunchSpec({
      executable: "/opt/bun/bin/bun",
      entrypoint: "/opt/stillon/bin/stillon",
      homeDirectory: "/home/alice",
      port: 4000,
      host: "100.64.0.1",
      trustProxy: true,
    })

    expect(launch.args).toEqual([
      "/opt/stillon/bin/stillon",
      "--no-open",
      "--strict-port",
      "--port",
      "4000",
      "--host",
      "100.64.0.1",
      "--trust-proxy",
    ])
  })

  test("rejects an empty service host", () => {
    expect(() => createServiceLaunchSpec({ entrypoint: "/stillon", host: "  " }))
      .toThrow("Service host cannot be empty")
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

  test("validates a service environment file before replacing a service", async () => {
    const directory = await createTemporaryDirectory()
    let installed = false
    const backend: ServiceBackend = {
      install: async () => { installed = true },
      status: async () => {},
      logs: async () => {},
      uninstall: async () => {},
    }

    await expect(manageService("install", {
      backend,
      entrypoint: "/stillon",
      homeDirectory: directory,
      environmentFile: path.join(directory, "missing.env"),
    })).rejects.toThrow("Service environment file does not exist")

    expect(installed).toBe(false)
  })

  test("accepts an explicit env file and reports its persisted path after installation", async () => {
    const directory = await createTemporaryDirectory()
    const environmentFile = path.join(directory, "agent-egress.env")
    await writeFile(environmentFile, "HTTPS_PROXY=http://127.0.0.1:7890\n", "utf8")
    const logs: string[] = []
    let launch: ServiceBackendContext["launch"] | undefined
    const backend: ServiceBackend = {
      install: async (context) => { launch = context.launch },
      status: async () => {},
      logs: async () => {},
      uninstall: async () => {},
    }

    await manageService("install", {
      backend,
      entrypoint: "/stillon",
      homeDirectory: directory,
      environmentFile,
      log: (message) => logs.push(message),
    })

    expect(launch?.args).toContain("--env-file")
    expect(launch?.args).toContain(environmentFile)
    expect(logs).toContain(`Service environment file: ${environmentFile}`)
  })

  test("loads proxy variables through Bun before the service entrypoint starts", async () => {
    const directory = await createTemporaryDirectory()
    const environmentFile = path.join(directory, "agent-egress.env")
    await writeFile(environmentFile, [
      "HTTP_PROXY=http://127.0.0.1:7890",
      "HTTPS_PROXY=http://127.0.0.1:7890",
      "ALL_PROXY=socks5://127.0.0.1:1080",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "",
    ].join("\n"), "utf8")

    const result = await runServiceCommand(process.execPath, [
      "--env-file",
      environmentFile,
      "--eval",
      "console.log(JSON.stringify({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY }))",
    ], {
      env: { PATH: process.env.PATH },
    })

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" })
    expect(JSON.parse(result.stdout)).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:1080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    })
  })
})

describe("assertReadableServiceEnvironmentFile", () => {
  test("rejects a directory instead of letting Bun try to load it", async () => {
    const directory = await createTemporaryDirectory()

    await expect(assertReadableServiceEnvironmentFile(directory)).rejects.toThrow(
      `Service environment path is not a file: ${directory}`,
    )
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
