import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createMacosServiceBackend,
  generateLaunchAgentPlist,
  getMacosServicePaths,
  LAUNCH_AGENT_LABEL,
} from "./macos"
import type {
  ServiceBackendContext,
  ServiceCommandOptions,
  ServiceCommandResult,
  ServiceLaunchSpec,
} from "./types"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createTempHome() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stillon-macos-service-"))
  tempDirectories.push(directory)
  return directory
}

function createLaunchSpec(homeDirectory: string, overrides: Partial<ServiceLaunchSpec> = {}): ServiceLaunchSpec {
  return {
    executable: "/Users/tester/.bun/bin/bun",
    args: ["run", "/Users/tester/stillon/src/server/cli.ts", "--no-open", "--port", "3210", "--strict-port"],
    workingDirectory: "/Users/tester/stillon",
    homeDirectory,
    pathEnvironment: "/Users/tester/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    ...overrides,
  }
}

function commandResult(overrides: Partial<ServiceCommandResult> = {}): ServiceCommandResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  }
}

interface CommandCall {
  command: string
  args: string[]
  options?: ServiceCommandOptions
}

function createHarness(
  launch: ServiceLaunchSpec,
  responses: Array<ServiceCommandResult | ((call: CommandCall) => ServiceCommandResult)>,
) {
  const calls: CommandCall[] = []
  const logs: string[] = []
  const warnings: string[] = []

  const context: ServiceBackendContext = {
    launch,
    run: async (command, args, options) => {
      const call = { command, args: [...args], options }
      calls.push(call)
      const response = responses.shift()
      if (!response) throw new Error(`Missing response for ${command} ${args.join(" ")}`)
      return typeof response === "function" ? response(call) : response
    },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
  }

  return { calls, context, logs, warnings }
}

describe("getMacosServicePaths", () => {
  test("uses the per-user LaunchAgents and StillOn log directories", () => {
    expect(getMacosServicePaths("/Users/tester")).toEqual({
      launchAgentsDirectory: "/Users/tester/Library/LaunchAgents",
      plistPath: `/Users/tester/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`,
      logDirectory: "/Users/tester/Library/Logs/StillOn",
      stdoutLogPath: "/Users/tester/Library/Logs/StillOn/stillon.out.log",
      stderrLogPath: "/Users/tester/Library/Logs/StillOn/stillon.err.log",
    })
  })
})

describe("generateLaunchAgentPlist", () => {
  test("generates a deterministic, always-on per-user LaunchAgent", () => {
    const spec = createLaunchSpec("/Users/tester")
    const plist = generateLaunchAgentPlist(spec)

    expect(plist).toBe(generateLaunchAgentPlist(spec))
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain("<key>ProgramArguments</key>")
    expect(plist).toContain("<string>/Users/tester/.bun/bin/bun</string>")
    expect(plist).toContain("<string>--strict-port</string>")
    expect(plist).toContain("<key>WorkingDirectory</key>\n    <string>/Users/tester/stillon</string>")
    expect(plist).toContain("<key>HOME</key>\n      <string>/Users/tester</string>")
    expect(plist).toContain("<key>PATH</key>")
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>")
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>")
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>")
    expect(plist).toContain("<key>StandardOutPath</key>\n    <string>/Users/tester/Library/Logs/StillOn/stillon.out.log</string>")
    expect(plist.endsWith("\n")).toBe(true)
  })

  test("XML-escapes every user-controlled plist string", () => {
    const spec = createLaunchSpec(`/Users/A & B <home> "double" 'single'`, {
      executable: `/Applications/StillOn & <Tools> "bin" 'bun'`,
      args: [`--project=A&B<>'"`],
      workingDirectory: `/Users/A & B/<project> "quoted" 'single'`,
      pathEnvironment: `/opt/A&B/<bin>:"quoted":'single'`,
    })
    const plist = generateLaunchAgentPlist(spec)

    expect(plist).toContain(
      "/Applications/StillOn &amp; &lt;Tools&gt; &quot;bin&quot; &apos;bun&apos;",
    )
    expect(plist).toContain("--project=A&amp;B&lt;&gt;&apos;&quot;")
    expect(plist).toContain("/Users/A &amp; B/&lt;project&gt; &quot;quoted&quot; &apos;single&apos;")
    expect(plist).toContain("/opt/A&amp;B/&lt;bin&gt;:&quot;quoted&quot;:&apos;single&apos;")
    expect(plist).not.toContain(spec.executable)
    expect(plist).not.toContain(spec.workingDirectory)
  })
})

describe("macOS service backend", () => {
  test("installs a new LaunchAgent and starts it in the current GUI domain", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    const notLoaded = commandResult({ code: 113, stderr: "service not found" })
    const { calls, context, logs } = createHarness(launch, [notLoaded, commandResult(), commandResult()])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.install(context)

    expect(calls).toEqual([
      { command: "/bin/launchctl", args: ["print", `gui/501/${LAUNCH_AGENT_LABEL}`], options: undefined },
      { command: "/bin/launchctl", args: ["bootstrap", "gui/501", paths.plistPath], options: undefined },
      {
        command: "/bin/launchctl",
        args: ["kickstart", "-k", `gui/501/${LAUNCH_AGENT_LABEL}`],
        options: undefined,
      },
    ])
    expect(await readFile(paths.plistPath, "utf8")).toBe(generateLaunchAgentPlist(launch))
    expect((await stat(paths.plistPath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.logDirectory)).isDirectory()).toBe(true)
    expect(logs).toContain(`Installed and started StillOn LaunchAgent: ${paths.plistPath}`)
  })

  test("prepares the replacement plist before reloading an existing job", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    const { calls, context } = createHarness(launch, [
      commandResult({ stdout: "loaded" }),
      commandResult(),
      commandResult(),
      commandResult(),
    ])
    const backend = createMacosServiceBackend({ uid: 502 })

    await backend.install(context)

    expect(calls.map(({ args }) => args)).toEqual([
      ["print", `gui/502/${LAUNCH_AGENT_LABEL}`],
      ["bootout", `gui/502/${LAUNCH_AGENT_LABEL}`],
      ["bootstrap", "gui/502", paths.plistPath],
      ["kickstart", "-k", `gui/502/${LAUNCH_AGENT_LABEL}`],
    ])
  })

  test("does not stop an existing job when writing its replacement plist fails", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.plistPath, { recursive: true })
    const { calls, context } = createHarness(launch, [commandResult({ stdout: "loaded" })])
    const backend = createMacosServiceBackend({ uid: 502 })

    await expect(backend.install(context)).rejects.toThrow()

    expect(calls).toEqual([
      { command: "/bin/launchctl", args: ["print", `gui/502/${LAUNCH_AGENT_LABEL}`], options: undefined },
    ])
  })

  test("stops installation when bootstrap fails", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const failure = commandResult({ code: 5, stderr: "input/output error" })
    const { calls, context } = createHarness(launch, [commandResult({ code: 113 }), failure])
    const backend = createMacosServiceBackend({ uid: 501 })

    await expect(backend.install(context)).rejects.toThrow(
      "launchctl bootstrap failed (exit code 5): input/output error",
    )
    expect(calls.map(({ args }) => args[0])).toEqual(["print", "bootstrap"])
  })

  test("does not overwrite the plist when the launchd query itself fails", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.launchAgentsDirectory, { recursive: true })
    await writeFile(paths.plistPath, "existing plist", "utf8")
    const { context } = createHarness(launch, [
      commandResult({ code: 1, stderr: "operation not permitted" }),
    ])
    const backend = createMacosServiceBackend({ uid: 501 })

    await expect(backend.install(context)).rejects.toThrow(
      "launchctl print failed (exit code 1): operation not permitted",
    )
    expect(await readFile(paths.plistPath, "utf8")).toBe("existing plist")
  })

  test("reports loaded service status from launchctl", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const { calls, context, logs, warnings } = createHarness(launch, [
      commandResult({ stdout: `${LAUNCH_AGENT_LABEL} = { state = running; }\n` }),
    ])
    const backend = createMacosServiceBackend({ uid: 503 })

    await backend.status(context)

    expect(calls[0]?.args).toEqual(["print", `gui/503/${LAUNCH_AGENT_LABEL}`])
    expect(logs).toEqual([`${LAUNCH_AGENT_LABEL} = { state = running; }`])
    expect(warnings).toEqual([])
  })

  test("distinguishes an installed but unloaded service", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.launchAgentsDirectory, { recursive: true })
    await writeFile(paths.plistPath, "plist", "utf8")
    const { context, logs, warnings } = createHarness(launch, [
      commandResult({ code: 113, stderr: "Could not find service" }),
    ])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.status(context)

    expect(logs).toEqual([`StillOn service is installed but not loaded: ${paths.plistPath}`])
    expect(warnings).toEqual(["Could not find service"])
  })

  test("reports a service that is not installed without throwing", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const { context, logs, warnings } = createHarness(launch, [
      commandResult({ code: 113, stderr: "Could not find service" }),
    ])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.status(context)

    expect(logs).toEqual(["StillOn service is not installed."])
    expect(warnings).toEqual([])
  })

  test("shows recent stdout and stderr logs without invoking a shell", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.logDirectory, { recursive: true })
    await writeFile(paths.stdoutLogPath, "out", "utf8")
    await writeFile(paths.stderrLogPath, "err", "utf8")
    const { calls, context, logs, warnings } = createHarness(launch, [
      commandResult({ stdout: "recent output\n", stderr: "tail warning\n" }),
    ])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.logs(context)

    expect(calls).toEqual([
      {
        command: "/usr/bin/tail",
        args: ["-n", "200", paths.stdoutLogPath, paths.stderrLogPath],
        options: undefined,
      },
    ])
    expect(logs).toEqual(["recent output"])
    expect(warnings).toEqual(["tail warning"])
  })

  test("reports when launchd has not created log files yet", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    const { calls, context, logs } = createHarness(launch, [])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.logs(context)

    expect(calls).toEqual([])
    expect(logs).toEqual([`No StillOn service logs yet. Expected logs under: ${paths.logDirectory}`])
  })

  test("unloads a running service before removing its plist", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.launchAgentsDirectory, { recursive: true })
    await writeFile(paths.plistPath, "plist", "utf8")
    const { calls, context, logs } = createHarness(launch, [commandResult({ stdout: "loaded" }), commandResult()])
    const backend = createMacosServiceBackend({ uid: 504 })

    await backend.uninstall(context)

    expect(calls.map(({ args }) => args)).toEqual([
      ["print", `gui/504/${LAUNCH_AGENT_LABEL}`],
      ["bootout", `gui/504/${LAUNCH_AGENT_LABEL}`],
    ])
    await expect(stat(paths.plistPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(logs).toEqual(["Uninstalled StillOn LaunchAgent. Existing log files were preserved."])
  })

  test("makes uninstall idempotent when no job or plist exists", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const { calls, context, logs } = createHarness(launch, [commandResult({ code: 113 })])
    const backend = createMacosServiceBackend({ uid: 501 })

    await backend.uninstall(context)

    expect(calls.map(({ args }) => args[0])).toEqual(["print"])
    expect(logs).toEqual(["StillOn service is not installed."])
  })

  test("preserves the plist when an active job cannot be unloaded", async () => {
    const homeDirectory = await createTempHome()
    const launch = createLaunchSpec(homeDirectory)
    const paths = getMacosServicePaths(homeDirectory)
    await mkdir(paths.launchAgentsDirectory, { recursive: true })
    await writeFile(paths.plistPath, "plist", "utf8")
    const { context } = createHarness(launch, [
      commandResult({ stdout: "loaded" }),
      commandResult({ code: 1, stderr: "operation not permitted" }),
    ])
    const backend = createMacosServiceBackend({ uid: 501 })

    await expect(backend.uninstall(context)).rejects.toThrow(
      "launchctl bootout failed (exit code 1): operation not permitted",
    )
    expect(await readFile(paths.plistPath, "utf8")).toBe("plist")
  })
})
