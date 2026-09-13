import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { runServiceCommand } from "../service"
import { assertCommandSucceeded, type ServiceCommandRunner } from "../service/types"
import { encodeWindowsPowerShell, encodeWindowsTaskXml, escapeWindowsTaskXml } from "../service/windows"
import type { UpdateDeployment } from "./model"

export const UPDATE_TASK = "StillOn Updater"
export const UPDATE_AGENT = "com.bzbj.stillon.updater"
const xml = escapeWindowsTaskXml
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`

export function windowsUpdaterXml(deployment: UpdateDeployment, user: string, now = new Date()) {
  if (!user.trim()) throw new Error("Missing Windows user identity.")
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$env:HOME = ${ps(deployment.launch.homeDirectory)}`,
    `$env:USERPROFILE = ${ps(deployment.launch.homeDirectory)}`,
    `$env:PATH = ${ps(deployment.launch.pathEnvironment)}`,
    `Set-Location -LiteralPath ${ps(deployment.root)}`,
    // No console, no caller job/terminal, no recursive self-invocation.
    `$ErrorActionPreference = 'Continue'`,
    `& ${ps(deployment.launch.executable)} ${deployment.launch.environmentFile ? `--env-file ${ps(deployment.launch.environmentFile)}` : "--no-env-file"} ${ps(deployment.controller)} 'worker' ${ps(deployment.root)} 1>> ${ps(path.win32.join(deployment.root, "worker.log"))} 2>&1`,
    "exit $LASTEXITCODE",
  ].join("\r\n")
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Independent StillOn source update and recovery worker.</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${now.toISOString()}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
<Principals><Principal id="User"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>conhost.exe</Command><Arguments>--headless powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodeWindowsPowerShell(command)}</Arguments><WorkingDirectory>${xml(deployment.root)}</WorkingDirectory></Exec></Actions>
</Task>`
}

export function macosUpdaterPlist(deployment: UpdateDeployment) {
  const args = [deployment.launch.executable, ...(deployment.launch.environmentFile ? ["--env-file", deployment.launch.environmentFile] : ["--no-env-file"]), deployment.controller, "worker", deployment.root]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${UPDATE_AGENT}</string>
<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(deployment.root)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(deployment.launch.homeDirectory)}</string><key>PATH</key><string>${xml(deployment.launch.pathEnvironment)}</string></dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.posix.join(deployment.root, "worker.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.posix.join(deployment.root, "worker.log"))}</string>
</dict></plist>`
}

export async function installUpdateWorker(deployment: UpdateDeployment, run: ServiceCommandRunner = runServiceCommand) {
  if (deployment.platform === "win32") {
    const identity = await run("whoami.exe", [])
    assertCommandSucceeded("whoami", identity)
    const file = path.join(deployment.root, "updater-task.xml")
    await writeFile(file, encodeWindowsTaskXml(windowsUpdaterXml(deployment, identity.stdout.trim())))
    assertCommandSucceeded("Register updater", await run("schtasks.exe", ["/Create", "/TN", UPDATE_TASK, "/XML", file, "/F"]))
    return
  }
  const directory = path.join(deployment.launch.homeDirectory, "Library", "LaunchAgents")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${UPDATE_AGENT}.plist`)
  await writeFile(file, macosUpdaterPlist(deployment), { mode: 0o600 })
  const domain = `gui/${process.getuid!()}`
  const loaded = await run("/bin/launchctl", ["print", `${domain}/${UPDATE_AGENT}`])
  if (loaded.code === 0) assertCommandSucceeded("Unload updater", await run("/bin/launchctl", ["bootout", `${domain}/${UPDATE_AGENT}`]))
  else if (![3, 113].includes(loaded.code ?? -1)) assertCommandSucceeded("Inspect updater", loaded)
  assertCommandSucceeded("Register updater", await run("/bin/launchctl", ["bootstrap", domain, file]))
}

export async function wakeUpdateWorker(deployment: UpdateDeployment, run: ServiceCommandRunner = runServiceCommand) {
  const result = deployment.platform === "win32"
    ? await run("schtasks.exe", ["/Run", "/TN", UPDATE_TASK])
    : await run("/bin/launchctl", ["kickstart", `gui/${process.getuid!()}/${UPDATE_AGENT}`])
  assertCommandSucceeded("Start independent updater", result)
}
