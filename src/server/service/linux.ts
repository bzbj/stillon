import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  assertCommandSucceeded,
  formatCommandFailure,
  type ServiceBackend,
  type ServiceBackendContext,
  type ServiceCommandResult,
  type ServiceLaunchSpec,
} from "./types"

export const SYSTEMD_UNIT_NAME = "stillon.service"

const SYSTEMCTL_COMMAND = "systemctl"
const JOURNALCTL_COMMAND = "journalctl"

function escapeSystemdString(value: string, escapeDollar: boolean) {
  let escaped = ""

  for (const character of value) {
    const codePoint = character.codePointAt(0)

    if (codePoint === 0) {
      throw new Error("systemd unit values cannot contain NUL characters")
    }

    switch (character) {
      case "\\":
        escaped += "\\\\"
        break
      case '"':
        escaped += '\\"'
        break
      case "\n":
        escaped += "\\n"
        break
      case "\r":
        escaped += "\\r"
        break
      case "\t":
        escaped += "\\t"
        break
      case "%":
        escaped += "%%"
        break
      case "$":
        escaped += escapeDollar ? "$$" : "$"
        break
      default:
        if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
          escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`
        } else {
          escaped += character
        }
    }
  }

  return `"${escaped}"`
}

function quoteSystemdValue(value: string) {
  return escapeSystemdString(value, false)
}

function quoteSystemdExecArgument(value: string) {
  // systemd treats a standalone semicolon as a command separator even when quoted.
  if (value === ";") return "\\;"
  return escapeSystemdString(value, true)
}

export function systemdUnitPath(homeDirectory: string) {
  return join(homeDirectory, ".config", "systemd", "user", SYSTEMD_UNIT_NAME)
}

export function renderSystemdUnit(launch: ServiceLaunchSpec) {
  const command = [launch.executable, ...launch.args].map(quoteSystemdExecArgument).join(" ")

  return [
    "[Unit]",
    "Description=StillOn background service",
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${quoteSystemdValue(launch.workingDirectory)}`,
    `Environment=${quoteSystemdValue(`HOME=${launch.homeDirectory}`)}`,
    `Environment=${quoteSystemdValue(`PATH=${launch.pathEnvironment}`)}`,
    `ExecStart=${command}`,
    "Restart=always",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

function commandLabel(command: string, args: string[]) {
  return [command, ...args].join(" ")
}

function commandSucceeded(result: ServiceCommandResult) {
  return result.code === 0 && result.signal === null
}

function emitCommandOutput(context: ServiceBackendContext, result: ServiceCommandResult) {
  const stdout = result.stdout.trimEnd()
  const stderr = result.stderr.trimEnd()

  if (stdout) context.log(stdout)
  if (stderr) context.warn(stderr)
}

async function runMutation(
  context: ServiceBackendContext,
  command: string,
  args: string[],
) {
  const result = await context.run(command, args)
  assertCommandSucceeded(commandLabel(command, args), result)
  return result
}

async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function reportsMissingUnit(result: ServiceCommandResult) {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase()
  return ["does not exist", "not found", "not loaded", "no such file"].some((text) =>
    detail.includes(text),
  )
}

async function install(context: ServiceBackendContext) {
  const unitPath = systemdUnitPath(context.launch.homeDirectory)
  await mkdir(dirname(unitPath), { recursive: true })
  await writeFile(unitPath, renderSystemdUnit(context.launch), {
    encoding: "utf8",
    mode: 0o600,
  })

  await runMutation(context, SYSTEMCTL_COMMAND, ["--user", "daemon-reload"])
  await runMutation(context, SYSTEMCTL_COMMAND, [
    "--user",
    "enable",
    "--now",
    SYSTEMD_UNIT_NAME,
  ])

  context.log(`Installed StillOn user service at ${unitPath}`)
  context.log(
    'To keep StillOn running after logout, enable systemd linger for your account: loginctl enable-linger "$USER"',
  )
}

async function status(context: ServiceBackendContext) {
  const args = ["--user", "status", SYSTEMD_UNIT_NAME, "--no-pager", "--full"]
  const result = await context.run(SYSTEMCTL_COMMAND, args)
  emitCommandOutput(context, result)

  if (!commandSucceeded(result) && !result.stdout.trim() && !result.stderr.trim()) {
    context.warn(formatCommandFailure(commandLabel(SYSTEMCTL_COMMAND, args), result).message)
  }
}

async function logs(context: ServiceBackendContext) {
  const args = [
    "--user",
    "--unit",
    SYSTEMD_UNIT_NAME,
    "--lines",
    "200",
    "--no-pager",
  ]
  const result = await context.run(JOURNALCTL_COMMAND, args)
  emitCommandOutput(context, result)

  if (!commandSucceeded(result) && !result.stdout.trim() && !result.stderr.trim()) {
    context.warn(formatCommandFailure(commandLabel(JOURNALCTL_COMMAND, args), result).message)
  }
}

async function uninstall(context: ServiceBackendContext) {
  const unitPath = systemdUnitPath(context.launch.homeDirectory)
  const unitExists = await pathExists(unitPath)
  const disableArgs = ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]
  const disableResult = await context.run(SYSTEMCTL_COMMAND, disableArgs)

  if (!commandSucceeded(disableResult) && unitExists && !reportsMissingUnit(disableResult)) {
    throw formatCommandFailure(commandLabel(SYSTEMCTL_COMMAND, disableArgs), disableResult)
  }

  await rm(unitPath, { force: true })
  await runMutation(context, SYSTEMCTL_COMMAND, ["--user", "daemon-reload"])

  context.log(
    unitExists
      ? `Uninstalled StillOn user service from ${unitPath}`
      : "StillOn user service is already uninstalled",
  )
}

export const linuxServiceBackend: ServiceBackend = {
  install,
  status,
  logs,
  uninstall,
}
