import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type {
  ServiceBackendContext,
  ServiceCommandResult,
  ServiceCommandRunner,
  ServiceLaunchSpec,
} from "./types"
import {
  WINDOWS_RESTART_COUNT,
  WINDOWS_RESTART_INTERVAL,
  WINDOWS_LOG_TAIL_BYTES,
  WINDOWS_LOG_TAIL_LINES,
  WINDOWS_SCHEDULER_COMMAND,
  WINDOWS_TASK_NAME,
  buildWindowsServicePowerShell,
  buildWindowsTaskXml,
  encodeWindowsPowerShell,
  escapeWindowsTaskXml,
  getWindowsServicePaths,
  windowsServiceBackend,
} from "./windows"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-windows-service-"))
  temporaryDirectories.push(directory)
  return directory
}

function createLaunch(overrides: Partial<ServiceLaunchSpec> = {}): ServiceLaunchSpec {
  return {
    executable: "C:\\Program Files\\Bun\\bun.exe",
    args: ["C:\\Users\\Alice\\StillOn\\bin\\stillon", "--no-open", "--strict-port"],
    workingDirectory: "C:\\Users\\Alice\\StillOn & Friends",
    homeDirectory: "C:\\Users\\Alice",
    pathEnvironment: "C:\\Program Files\\Bun;C:\\Windows\\System32",
    localAppDataDirectory: "C:\\Users\\Alice\\AppData\\Local",
    ...overrides,
  }
}

function commandResult(
  overrides: Partial<ServiceCommandResult> = {},
): ServiceCommandResult {
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
}

function createContext(
  launch: ServiceLaunchSpec,
  handler: (call: CommandCall) => ServiceCommandResult | Promise<ServiceCommandResult>,
) {
  const calls: CommandCall[] = []
  const logs: string[] = []
  const warnings: string[] = []
  const run: ServiceCommandRunner = async (command, args) => {
    const call = { command, args }
    calls.push(call)
    return handler(call)
  }
  const context: ServiceBackendContext = {
    launch,
    run,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
  }
  return { calls, context, logs, warnings }
}

function decodeEncodedCommand(xml: string) {
  const match = xml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)<\/Arguments>/)
  if (!match?.[1]) throw new Error("Task XML does not contain an encoded PowerShell command")
  return Buffer.from(match[1], "base64").toString("utf16le")
}

describe("Windows service configuration", () => {
  test("escapes XML metacharacters deterministically", () => {
    expect(escapeWindowsTaskXml(`a&<b>\"'`)).toBe("a&amp;&lt;b&gt;&quot;&apos;")
  })

  test("stores files in local app data with a home-directory fallback", () => {
    expect(getWindowsServicePaths(createLaunch())).toEqual({
      directory: "C:\\Users\\Alice\\AppData\\Local\\StillOn",
      taskXml: "C:\\Users\\Alice\\AppData\\Local\\StillOn\\service-task.xml",
      stdoutLog: "C:\\Users\\Alice\\AppData\\Local\\StillOn\\service.out.log",
      stderrLog: "C:\\Users\\Alice\\AppData\\Local\\StillOn\\service.err.log",
    })

    expect(getWindowsServicePaths(createLaunch({ localAppDataDirectory: undefined }))).toEqual({
      directory: "C:\\Users\\Alice\\.stillon",
      taskXml: "C:\\Users\\Alice\\.stillon\\service-task.xml",
      stdoutLog: "C:\\Users\\Alice\\.stillon\\service.out.log",
      stderrLog: "C:\\Users\\Alice\\.stillon\\service.err.log",
    })

    expect(getWindowsServicePaths(createLaunch({
      homeDirectory: "/Users/alice",
      localAppDataDirectory: "/tmp/stillon-service-test",
    }))).toEqual({
      directory: "/tmp/stillon-service-test/StillOn",
      taskXml: "/tmp/stillon-service-test/StillOn/service-task.xml",
      stdoutLog: "/tmp/stillon-service-test/StillOn/service.out.log",
      stderrLog: "/tmp/stillon-service-test/StillOn/service.err.log",
    })
  })

  test("builds a current-user task with bounded restarts and encoded log capture", () => {
    const launch = createLaunch({
      args: ["script's path.ts", "--label", "value & more"],
    })
    const xml = buildWindowsTaskXml(launch, "DOMAIN\\Alice & Bob")
    const powerShell = decodeEncodedCommand(xml)

    expect(xml).toContain("<LogonTrigger>")
    expect(xml).toContain("<UserId>DOMAIN\\Alice &amp; Bob</UserId>")
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>")
    expect(xml).toContain(`<Interval>${WINDOWS_RESTART_INTERVAL}</Interval>`)
    expect(xml).toContain(`<Count>${WINDOWS_RESTART_COUNT}</Count>`)
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\Alice\\StillOn &amp; Friends</WorkingDirectory>")
    expect(powerShell).toContain("$arguments = @('script''s path.ts', '--label', 'value & more')")
    expect(powerShell).toContain("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'")
    expect(powerShell).toContain("1>> 'C:\\Users\\Alice\\AppData\\Local\\StillOn\\service.out.log'")
    expect(powerShell).toContain("2>> 'C:\\Users\\Alice\\AppData\\Local\\StillOn\\service.err.log'")
    expect(powerShell).toContain("$env:Path = 'C:\\Program Files\\Bun;C:\\Windows\\System32'")
    expect(xml).not.toContain("script's path.ts")
  })

  test("encodes PowerShell as UTF-16LE for Windows PowerShell", () => {
    const script = "Write-Output '你好'"
    expect(Buffer.from(encodeWindowsPowerShell(script), "base64").toString("utf16le")).toBe(script)
  })

  test("refuses to persist password and tunnel-token arguments", () => {
    for (const args of [
      ["--password", "do-not-store"],
      ["--password=do-not-store"],
      ["--cloudflared", "do-not-store"],
      ["--cloudflared=do-not-store"],
    ]) {
      expect(() => buildWindowsServicePowerShell(createLaunch({ args }))).toThrow(
        "cannot be persisted in a Windows scheduled task",
      )
    }
  })
})

describe("windowsServiceBackend", () => {
  test("installs the XML task for the current user and starts it", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const { calls, context, logs } = createContext(launch, ({ command, args }) => {
      if (command === "whoami.exe") return commandResult({ stdout: "DOMAIN\\Alice\r\n" })
      if (args[0] === "/Query") return commandResult({ code: 1, stderr: "not found" })
      return commandResult()
    })

    await windowsServiceBackend.install(context)

    const servicePaths = getWindowsServicePaths(launch)
    const writtenXml = await readFile(servicePaths.taskXml, "utf8")
    expect(writtenXml).toBe(buildWindowsTaskXml(launch, "DOMAIN\\Alice"))
    expect(calls).toEqual([
      { command: "whoami.exe", args: [] },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: ["/Query", "/TN", WINDOWS_TASK_NAME],
      },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", servicePaths.taskXml, "/F"],
      },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: ["/Run", "/TN", WINDOWS_TASK_NAME],
      },
    ])
    expect(logs[0]).toContain("Installed and started")
    expect(logs[1]).toContain(servicePaths.stdoutLog)
  })

  test("stops after a failed task creation", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const { calls, context } = createContext(launch, ({ command, args }) => {
      if (command === "whoami.exe") return commandResult({ stdout: "DOMAIN\\Alice" })
      if (args[0] === "/Query") return commandResult({ code: 1, stderr: "not found" })
      return commandResult({ code: 1, stderr: "invalid task XML" })
    })

    await expect(windowsServiceBackend.install(context)).rejects.toThrow("invalid task XML")
    expect(calls).toEqual([
      { command: "whoami.exe", args: [] },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: ["/Query", "/TN", WINDOWS_TASK_NAME],
      },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: [
          "/Create",
          "/TN",
          WINDOWS_TASK_NAME,
          "/XML",
          getWindowsServicePaths(launch).taskXml,
          "/F",
        ],
      },
    ])
  })

  test("writes replacement XML before stopping and replacing an installed task", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    let xmlObservedAtQuery = ""
    const { calls, context } = createContext(launch, async ({ command, args }) => {
      if (command === "whoami.exe") return commandResult({ stdout: "DOMAIN\\Alice" })
      if (args[0] === "/Query") {
        xmlObservedAtQuery = await readFile(servicePaths.taskXml, "utf8")
      }
      return commandResult()
    })

    await windowsServiceBackend.install(context)

    expect(xmlObservedAtQuery).toBe(buildWindowsTaskXml(launch, "DOMAIN\\Alice"))
    expect(calls).toEqual([
      { command: "whoami.exe", args: [] },
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/Query", "/TN", WINDOWS_TASK_NAME] },
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/End", "/TN", WINDOWS_TASK_NAME] },
      {
        command: WINDOWS_SCHEDULER_COMMAND,
        args: ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", servicePaths.taskXml, "/F"],
      },
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
    ])
  })

  test("continues reinstall when the installed task is not running", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const { calls, context, warnings } = createContext(launch, ({ command, args }) => {
      if (command === "whoami.exe") return commandResult({ stdout: "DOMAIN\\Alice" })
      if (args[0] === "/End") return commandResult({ code: 1, stderr: "not running" })
      return commandResult()
    })

    await windowsServiceBackend.install(context)

    expect(calls.map(({ command, args }) => args[0] ?? command)).toEqual([
      "whoami.exe",
      "/Query",
      "/End",
      "/Create",
      "/Run",
    ])
    expect(warnings).toEqual([
      "The existing StillOn task was not running or could not be stopped; continuing install.",
    ])
  })

  test("does not query or stop an existing task when replacement XML cannot be written", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.taskXml, { recursive: true })
    const { calls, context } = createContext(launch, ({ command }) => (
      command === "whoami.exe"
        ? commandResult({ stdout: "DOMAIN\\Alice" })
        : commandResult()
    ))

    await expect(windowsServiceBackend.install(context)).rejects.toThrow()

    expect(calls).toEqual([{ command: "whoami.exe", args: [] }])
  })

  test("reports installed task details and treats a missing task as observational", async () => {
    const installed = createContext(createLaunch(), () => commandResult({
      stdout: "TaskName: StillOn\r\nStatus: Running\r\n",
    }))
    await windowsServiceBackend.status(installed.context)
    expect(installed.calls[0]).toEqual({
      command: WINDOWS_SCHEDULER_COMMAND,
      args: ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"],
    })
    expect(installed.logs).toEqual([
      "The StillOn background service is installed.",
      "TaskName: StillOn\r\nStatus: Running",
    ])

    const missing = createContext(createLaunch(), () => commandResult({ code: 1 }))
    await expect(windowsServiceBackend.status(missing.context)).resolves.toBeUndefined()
    expect(missing.logs).toEqual(["The StillOn background service is not installed."])
  })

  test("shows captured stdout and stderr logs", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.directory, { recursive: true })
    await Promise.all([
      writeFile(servicePaths.stdoutLog, "server listening\n", "utf8"),
      writeFile(servicePaths.stderrLog, "restarted once\n", "utf8"),
    ])
    const { context, logs } = createContext(launch, () => commandResult())

    await windowsServiceBackend.logs(context)

    expect(logs).toEqual([
      `StillOn stdout (${servicePaths.stdoutLog}):`,
      "server listening",
      `StillOn stderr (${servicePaths.stderrLog}):`,
      "restarted once",
    ])
  })

  test("reads UTF-16LE logs produced by Windows PowerShell 5.1", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.directory, { recursive: true })
    const utf16Log = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("server listening\r\nsecond line\r\n", "utf16le"),
    ])
    await writeFile(servicePaths.stdoutLog, utf16Log)
    await writeFile(servicePaths.stderrLog, "", "utf8")
    const { context, logs } = createContext(launch, () => commandResult())

    await windowsServiceBackend.logs(context)

    expect(logs[1]).toBe("server listening\nsecond line")
    expect(logs[3]).toBe("(empty)")
  })

  test("bounds log snapshots to recent lines and bytes", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.directory, { recursive: true })
    const lines = Array.from({ length: WINDOWS_LOG_TAIL_LINES + 20 }, (_, index) => `line-${index}`)
    await writeFile(servicePaths.stdoutLog, `${lines.join("\n")}\n`, "utf8")
    await writeFile(servicePaths.stderrLog, `ignored-${"x".repeat(WINDOWS_LOG_TAIL_BYTES + 10)}`, "utf8")
    const { context, logs } = createContext(launch, () => commandResult())

    await windowsServiceBackend.logs(context)

    const stdoutSnapshot = logs[1] ?? ""
    const stderrSnapshot = logs[3] ?? ""
    expect(stdoutSnapshot.split("\n")).toHaveLength(WINDOWS_LOG_TAIL_LINES)
    expect(stdoutSnapshot).not.toContain("line-19\n")
    expect(stdoutSnapshot).toStartWith("line-20\n")
    expect(stdoutSnapshot).toEndWith(`line-${WINDOWS_LOG_TAIL_LINES + 19}`)
    expect(Buffer.byteLength(stderrSnapshot, "utf8")).toBeLessThanOrEqual(WINDOWS_LOG_TAIL_BYTES)
  })

  test("warns when no captured logs exist", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const { context, warnings } = createContext(launch, () => commandResult())

    await windowsServiceBackend.logs(context)

    expect(warnings).toEqual([
      `No StillOn service logs found in ${getWindowsServicePaths(launch).directory}.`,
    ])
  })

  test("ends and deletes an installed task, then removes its generated XML", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.directory, { recursive: true })
    await writeFile(servicePaths.taskXml, "task xml", "utf8")
    const { calls, context, logs } = createContext(launch, () => commandResult())

    await windowsServiceBackend.uninstall(context)

    expect(calls).toEqual([
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/Query", "/TN", WINDOWS_TASK_NAME] },
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/End", "/TN", WINDOWS_TASK_NAME] },
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"] },
    ])
    expect(await Bun.file(servicePaths.taskXml).exists()).toBe(false)
    expect(logs).toEqual(["Uninstalled the StillOn background service."])
  })

  test("makes uninstall idempotent when the task is missing", async () => {
    const localAppDataDirectory = await makeTemporaryDirectory()
    const launch = createLaunch({ localAppDataDirectory })
    const servicePaths = getWindowsServicePaths(launch)
    await mkdir(servicePaths.directory, { recursive: true })
    await writeFile(servicePaths.taskXml, "stale task xml", "utf8")
    const { calls, context, logs } = createContext(
      launch,
      () => commandResult({ code: 1, stderr: "not found" }),
    )

    await windowsServiceBackend.uninstall(context)

    expect(calls).toEqual([
      { command: WINDOWS_SCHEDULER_COMMAND, args: ["/Query", "/TN", WINDOWS_TASK_NAME] },
    ])
    expect(await Bun.file(servicePaths.taskXml).exists()).toBe(false)
    expect(logs).toEqual(["The StillOn background service is not installed."])
  })
})
