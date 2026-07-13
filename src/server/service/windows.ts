import path from "node:path"
import { mkdir, open, rm, writeFile } from "node:fs/promises"
import {
  assertCommandSucceeded,
  type ServiceBackend,
  type ServiceLaunchSpec,
} from "./types"

export const WINDOWS_TASK_NAME = "StillOn"
export const WINDOWS_SCHEDULER_COMMAND = "schtasks.exe"
export const WINDOWS_RESTART_INTERVAL = "PT1M"
export const WINDOWS_RESTART_COUNT = 5
export const WINDOWS_LOG_TAIL_LINES = 200
export const WINDOWS_LOG_TAIL_BYTES = 128 * 1024

export interface WindowsServicePaths {
  directory: string
  taskXml: string
  stdoutLog: string
  stderrLog: string
}

function pathImplementationFor(basePath: string) {
  const hasWindowsDrive = /^[a-zA-Z]:[\\/]/.test(basePath)
  const isUncPath = basePath.startsWith("\\\\")
  return hasWindowsDrive || isUncPath || basePath.includes("\\")
    ? path.win32
    : path.posix
}

export function getWindowsServicePaths(launch: ServiceLaunchSpec): WindowsServicePaths {
  const localAppData = launch.localAppDataDirectory?.trim()
  const baseDirectory = localAppData || launch.homeDirectory
  const pathImplementation = pathImplementationFor(baseDirectory)
  const directory = localAppData
    ? pathImplementation.join(baseDirectory, "StillOn")
    : pathImplementation.join(baseDirectory, ".stillon")

  return {
    directory,
    taskXml: pathImplementation.join(directory, "service-task.xml"),
    stdoutLog: pathImplementation.join(directory, "service.out.log"),
    stderrLog: pathImplementation.join(directory, "service.err.log"),
  }
}

export function escapeWindowsTaskXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function quotePowerShellLiteral(value: string) {
  if (value.includes("\0")) {
    throw new Error("Windows service values cannot contain null bytes")
  }
  return `'${value.replaceAll("'", "''")}'`
}

function findPersistedSecretFlag(args: string[]) {
  return args.find((arg) => {
    const normalized = arg.toLowerCase()
    return normalized === "--password"
      || normalized.startsWith("--password=")
  })
}

export function assertNoWindowsServiceSecrets(args: string[]) {
  const secretFlag = findPersistedSecretFlag(args)
  if (!secretFlag) return
  const flagName = secretFlag.split("=", 1)[0]
  throw new Error(`${flagName} cannot be persisted in a Windows scheduled task`)
}

export function buildWindowsServicePowerShell(
  launch: ServiceLaunchSpec,
  servicePaths: WindowsServicePaths = getWindowsServicePaths(launch),
) {
  assertNoWindowsServiceSecrets(launch.args)
  const argumentLiterals = launch.args.map(quotePowerShellLiteral).join(", ")

  return [
    "$ErrorActionPreference = 'Stop'",
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    `$env:HOME = ${quotePowerShellLiteral(launch.homeDirectory)}`,
    `$env:USERPROFILE = ${quotePowerShellLiteral(launch.homeDirectory)}`,
    `$env:Path = ${quotePowerShellLiteral(launch.pathEnvironment)}`,
    `Set-Location -LiteralPath ${quotePowerShellLiteral(launch.workingDirectory)}`,
    `$arguments = @(${argumentLiterals})`,
    `& ${quotePowerShellLiteral(launch.executable)} @arguments 1>> ${quotePowerShellLiteral(servicePaths.stdoutLog)} 2>> ${quotePowerShellLiteral(servicePaths.stderrLog)}`,
    "$serviceExitCode = $LASTEXITCODE",
    "exit $serviceExitCode",
  ].join("\r\n")
}

export function encodeWindowsPowerShell(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

export function buildWindowsTaskXml(
  launch: ServiceLaunchSpec,
  userId: string,
  servicePaths: WindowsServicePaths = getWindowsServicePaths(launch),
) {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) {
    throw new Error("Cannot install the Windows service without the current user identity")
  }

  const encodedPowerShell = encodeWindowsPowerShell(
    buildWindowsServicePowerShell(launch, servicePaths),
  )
  const escapedUserId = escapeWindowsTaskXml(normalizedUserId)

  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Run StillOn in the current user session.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapedUserId}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="CurrentUser">
      <UserId>${escapedUserId}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${WINDOWS_RESTART_INTERVAL}</Interval>
      <Count>${WINDOWS_RESTART_COUNT}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="CurrentUser">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedPowerShell}</Arguments>
      <WorkingDirectory>${escapeWindowsTaskXml(launch.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

async function removeTaskXml(taskXml: string) {
  await rm(taskXml, { force: true })
}

function decodeLogBuffer(buffer: Buffer, utf16LittleEndian: boolean) {
  const decoded = buffer.toString(utf16LittleEndian ? "utf16le" : "utf8")
  return decoded.replace(/^\uFEFF/, "")
}

function takeRecentLogLines(contents: string, startedMidFile: boolean) {
  let boundedContents = contents
  if (startedMidFile) {
    const firstLineEnd = boundedContents.indexOf("\n")
    if (firstLineEnd >= 0) boundedContents = boundedContents.slice(firstLineEnd + 1)
  }

  const lines = boundedContents.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  return lines.slice(-WINDOWS_LOG_TAIL_LINES).join("\n")
}

async function readRecentLogFile(filePath: string) {
  let fileHandle
  try {
    fileHandle = await open(filePath, "r")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }

  try {
    const { size } = await fileHandle.stat()
    if (size === 0) return ""

    const prefix = Buffer.alloc(Math.min(3, size))
    await fileHandle.read(prefix, 0, prefix.length, 0)
    const utf16LittleEndian = prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe
    let start = Math.max(0, size - WINDOWS_LOG_TAIL_BYTES)
    if (utf16LittleEndian && start % 2 !== 0) start += 1
    const buffer = Buffer.alloc(size - start)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await fileHandle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const contents = decodeLogBuffer(buffer.subarray(0, bytesRead), utf16LittleEndian)
    return takeRecentLogLines(contents, start > 0)
  } finally {
    await fileHandle.close()
  }
}

export const windowsServiceBackend: ServiceBackend = {
  async install(context) {
    assertNoWindowsServiceSecrets(context.launch.args)

    const identityResult = await context.run("whoami.exe", [])
    assertCommandSucceeded("whoami.exe", identityResult)
    const userId = identityResult.stdout.trim()
    if (!userId) {
      throw new Error("whoami.exe returned an empty Windows user identity")
    }

    const servicePaths = getWindowsServicePaths(context.launch)
    const taskXml = buildWindowsTaskXml(context.launch, userId, servicePaths)
    await mkdir(servicePaths.directory, { recursive: true })
    await writeFile(servicePaths.taskXml, taskXml, "utf8")

    const existingTask = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Query",
      "/TN",
      WINDOWS_TASK_NAME,
    ])
    if (existingTask.code === 0 && existingTask.signal === null) {
      const endResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
        "/End",
        "/TN",
        WINDOWS_TASK_NAME,
      ])
      if (endResult.code !== 0 || endResult.signal !== null) {
        context.warn("The existing StillOn task was not running or could not be stopped; continuing install.")
      }
    }

    const createResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
      servicePaths.taskXml,
      "/F",
    ])
    assertCommandSucceeded(`${WINDOWS_SCHEDULER_COMMAND} /Create`, createResult)

    const runResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Run",
      "/TN",
      WINDOWS_TASK_NAME,
    ])
    assertCommandSucceeded(`${WINDOWS_SCHEDULER_COMMAND} /Run`, runResult)

    context.log("Installed and started the StillOn background service.")
    context.log(`Logs: ${servicePaths.stdoutLog} and ${servicePaths.stderrLog}`)
  },

  async status(context) {
    const result = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Query",
      "/TN",
      WINDOWS_TASK_NAME,
      "/FO",
      "LIST",
      "/V",
    ])

    if (result.code !== 0 || result.signal !== null) {
      context.log("The StillOn background service is not installed.")
      return
    }

    context.log("The StillOn background service is installed.")
    const details = result.stdout.trim()
    if (details) context.log(details)
  },

  async logs(context) {
    const servicePaths = getWindowsServicePaths(context.launch)
    const [stdout, stderr] = await Promise.all([
      readRecentLogFile(servicePaths.stdoutLog),
      readRecentLogFile(servicePaths.stderrLog),
    ])

    if (stdout === null && stderr === null) {
      context.warn(`No StillOn service logs found in ${servicePaths.directory}.`)
      return
    }

    context.log(`StillOn stdout (${servicePaths.stdoutLog}):`)
    context.log(stdout?.trimEnd() || "(empty)")
    context.log(`StillOn stderr (${servicePaths.stderrLog}):`)
    context.log(stderr?.trimEnd() || "(empty)")
  },

  async uninstall(context) {
    const servicePaths = getWindowsServicePaths(context.launch)
    const queryResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Query",
      "/TN",
      WINDOWS_TASK_NAME,
    ])

    if (queryResult.code !== 0 || queryResult.signal !== null) {
      await removeTaskXml(servicePaths.taskXml)
      context.log("The StillOn background service is not installed.")
      return
    }

    const endResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/End",
      "/TN",
      WINDOWS_TASK_NAME,
    ])
    if (endResult.code !== 0 || endResult.signal !== null) {
      context.warn("The StillOn task was not running or could not be stopped; continuing uninstall.")
    }

    const deleteResult = await context.run(WINDOWS_SCHEDULER_COMMAND, [
      "/Delete",
      "/TN",
      WINDOWS_TASK_NAME,
      "/F",
    ])
    assertCommandSucceeded(`${WINDOWS_SCHEDULER_COMMAND} /Delete`, deleteResult)

    await removeTaskXml(servicePaths.taskXml)
    context.log("Uninstalled the StillOn background service.")
  },
}
