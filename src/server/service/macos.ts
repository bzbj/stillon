import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import {
  assertCommandSucceeded,
  type ServiceBackend,
  type ServiceBackendContext,
  type ServiceCommandResult,
  type ServiceLaunchSpec,
} from "./types"

export const LAUNCH_AGENT_LABEL = "com.bzbj.stillon"

const LAUNCHCTL_PATH = "/bin/launchctl"
const TAIL_PATH = "/usr/bin/tail"
const LOG_LINE_COUNT = "200"
const SERVICE_NOT_FOUND_EXIT_CODES = new Set([3, 113])

export interface MacosServicePaths {
  launchAgentsDirectory: string
  plistPath: string
  logDirectory: string
  stdoutLogPath: string
  stderrLogPath: string
}

export interface MacosServiceBackendOptions {
  uid?: number
}

export function getMacosServicePaths(homeDirectory: string): MacosServicePaths {
  const launchAgentsDirectory = path.posix.join(homeDirectory, "Library", "LaunchAgents")
  const logDirectory = path.posix.join(homeDirectory, "Library", "Logs", "StillOn")

  return {
    launchAgentsDirectory,
    plistPath: path.posix.join(launchAgentsDirectory, `${LAUNCH_AGENT_LABEL}.plist`),
    logDirectory,
    stdoutLogPath: path.posix.join(logDirectory, "stillon.out.log"),
    stderrLogPath: path.posix.join(logDirectory, "stillon.err.log"),
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function plistString(value: string, indentation: string) {
  return `${indentation}<string>${escapeXml(value)}</string>`
}

export function generateLaunchAgentPlist(spec: ServiceLaunchSpec) {
  const paths = getMacosServicePaths(spec.homeDirectory)
  const programArguments = [spec.executable, ...spec.args]
    .map((argument) => plistString(argument, "      "))
    .join("\n")

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    plistString(LAUNCH_AGENT_LABEL, "    "),
    "    <key>ProgramArguments</key>",
    "    <array>",
    programArguments,
    "    </array>",
    "    <key>WorkingDirectory</key>",
    plistString(spec.workingDirectory, "    "),
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>HOME</key>",
    plistString(spec.homeDirectory, "      "),
    "      <key>PATH</key>",
    plistString(spec.pathEnvironment, "      "),
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ThrottleInterval</key>",
    "    <integer>10</integer>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardOutPath</key>",
    plistString(paths.stdoutLogPath, "    "),
    "    <key>StandardErrorPath</key>",
    plistString(paths.stderrLogPath, "    "),
    "  </dict>",
    "</plist>",
    "",
  ].join("\n")
}

function getCurrentUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("macOS service management requires a POSIX user ID")
  }
  return process.getuid()
}

function commandSucceeded(result: ServiceCommandResult) {
  return result.code === 0 && result.signal === null
}

function serviceIsNotLoaded(result: ServiceCommandResult) {
  return result.signal === null && result.code !== null && SERVICE_NOT_FOUND_EXIT_CODES.has(result.code)
}

function commandOutput(result: ServiceCommandResult) {
  return result.stderr.trim() || result.stdout.trim()
}

async function pathExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function removeFileIfPresent(filePath: string) {
  try {
    await unlink(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function launchdTargets(uid: number) {
  const domain = `gui/${uid}`
  return {
    domain,
    service: `${domain}/${LAUNCH_AGENT_LABEL}`,
  }
}

async function queryLoadedService(context: ServiceBackendContext, serviceTarget: string) {
  return context.run(LAUNCHCTL_PATH, ["print", serviceTarget])
}

function reportCommandOutput(context: ServiceBackendContext, result: ServiceCommandResult) {
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (stdout) context.log(stdout)
  if (stderr) context.warn(stderr)
}

export function createMacosServiceBackend(options: MacosServiceBackendOptions = {}): ServiceBackend {
  const getUid = () => options.uid ?? getCurrentUid()

  return {
    async install(context) {
      const paths = getMacosServicePaths(context.launch.homeDirectory)
      const targets = launchdTargets(getUid())
      const loaded = await queryLoadedService(context, targets.service)

      if (!commandSucceeded(loaded) && !serviceIsNotLoaded(loaded)) {
        assertCommandSucceeded("launchctl print", loaded)
      }

      await mkdir(paths.launchAgentsDirectory, { recursive: true })
      await mkdir(paths.logDirectory, { recursive: true })
      await writeFile(paths.plistPath, generateLaunchAgentPlist(context.launch), {
        encoding: "utf8",
        mode: 0o600,
      })
      await chmod(paths.plistPath, 0o600)

      if (commandSucceeded(loaded)) {
        const bootout = await context.run(LAUNCHCTL_PATH, ["bootout", targets.service])
        assertCommandSucceeded("launchctl bootout", bootout)
      }

      const bootstrap = await context.run(LAUNCHCTL_PATH, ["bootstrap", targets.domain, paths.plistPath])
      assertCommandSucceeded("launchctl bootstrap", bootstrap)

      const kickstart = await context.run(LAUNCHCTL_PATH, ["kickstart", "-k", targets.service])
      assertCommandSucceeded("launchctl kickstart", kickstart)

      context.log(`Installed and started StillOn LaunchAgent: ${paths.plistPath}`)
      context.log(`Logs: ${paths.logDirectory}`)
    },

    async status(context) {
      const paths = getMacosServicePaths(context.launch.homeDirectory)
      const targets = launchdTargets(getUid())
      const result = await queryLoadedService(context, targets.service)

      if (commandSucceeded(result)) {
        if (result.stdout.trim() || result.stderr.trim()) {
          reportCommandOutput(context, result)
        } else {
          context.log(`StillOn service is loaded: ${targets.service}`)
        }
        return
      }

      const installed = await pathExists(paths.plistPath)
      if (installed) {
        context.log(`StillOn service is installed but not loaded: ${paths.plistPath}`)
      } else {
        context.log("StillOn service is not installed.")
      }
      const detail = commandOutput(result)
      if (detail && (installed || !serviceIsNotLoaded(result))) context.warn(detail)
    },

    async logs(context) {
      const paths = getMacosServicePaths(context.launch.homeDirectory)
      const candidates = [paths.stdoutLogPath, paths.stderrLogPath]
      const existingLogPaths: string[] = []

      for (const candidate of candidates) {
        if (await pathExists(candidate)) existingLogPaths.push(candidate)
      }

      if (existingLogPaths.length === 0) {
        context.log(`No StillOn service logs yet. Expected logs under: ${paths.logDirectory}`)
        return
      }

      const result = await context.run(TAIL_PATH, ["-n", LOG_LINE_COUNT, ...existingLogPaths])
      reportCommandOutput(context, result)
      if (commandSucceeded(result) && !result.stdout.trim() && !result.stderr.trim()) {
        context.log("StillOn service log files are empty.")
      }
    },

    async uninstall(context) {
      const paths = getMacosServicePaths(context.launch.homeDirectory)
      const targets = launchdTargets(getUid())
      const loaded = await queryLoadedService(context, targets.service)

      if (commandSucceeded(loaded)) {
        const bootout = await context.run(LAUNCHCTL_PATH, ["bootout", targets.service])
        assertCommandSucceeded("launchctl bootout", bootout)
      } else if (!serviceIsNotLoaded(loaded)) {
        assertCommandSucceeded("launchctl print", loaded)
      }

      const removed = await removeFileIfPresent(paths.plistPath)
      if (removed || commandSucceeded(loaded)) {
        context.log("Uninstalled StillOn LaunchAgent. Existing log files were preserved.")
      } else {
        context.log("StillOn service is not installed.")
      }
    },
  }
}

export const macosServiceBackend = createMacosServiceBackend()
