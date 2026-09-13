import { runServiceCommand } from "../service"
import { assertCommandSucceeded } from "../service/types"
import { buildWindowsServicePowerShell, encodeWindowsPowerShell } from "../service/windows"
import type { ServiceLaunchSpec } from "../service/types"
import type { UpdateDeployment, UpdateRunnerStatus } from "./model"
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Task Scheduler can leave conhost's PowerShell/Bun children alive after /End. */
export async function stopWindowsEncodedProcesses(encoded: string) {
  if (!/^[A-Za-z0-9+/=]{32,}$/.test(encoded)) throw new Error("Missing native task command identity")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$expected = [IO.File]::ReadAllText($env:STILLON_WATCHDOG_IDENTITY_FILE)",
    "function Find-Owned { @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('conhost.exe','powershell.exe') -and $_.CommandLine -and [regex]::Match($_.CommandLine, '(?i)(?:^|\\s)-EncodedCommand\\s+([A-Za-z0-9+/=]+)(?:\\s|$)').Groups[1].Value -eq $expected }) }",
    "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
    "do {",
    "  $owned = Find-Owned",
    "  if ($owned.Count -eq 0) { exit 0 }",
    "  foreach ($candidate in $owned) {",
    "    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $candidate.ProcessId)",
    "    if ($null -eq $current -or $current.CreationDate -ne $candidate.CreationDate -or $current.CommandLine -ne $candidate.CommandLine) { continue }",
    "    $ErrorActionPreference = 'Continue'",
    "    & \"$env:SystemRoot\\System32\\taskkill.exe\" /PID ([string]$current.ProcessId) /T /F 2>$null | Out-Null",
    "    $ErrorActionPreference = 'Stop'",
    "  }",
    "  Start-Sleep -Milliseconds 100",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "if ((Find-Owned).Count -gt 0) { throw 'An owned native service process did not exit' }",
  ].join("\r\n")
  // Re-encoding a long PATH-bearing launch command can exceed CreateProcess's
  // command-line limit. Keep the helper command fixed-size and the payload local.
  const directory = await mkdtemp(path.join(os.tmpdir(), "stillon-watchdog-identity-"))
  const file = path.join(directory, "command.txt")
  try {
    await writeFile(file, encoded, { mode: 0o600 })
    assertCommandSucceeded("Stop owned native service process tree", await runServiceCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeWindowsPowerShell(script)], {
      env: { ...process.env, STILLON_WATCHDOG_IDENTITY_FILE: file },
    }))
  } finally {
    await unlink(file)
    await rmdir(directory)
  }
}

export async function stopWindowsServiceProcesses(launch: ServiceLaunchSpec) {
  await stopWindowsEncodedProcesses(encodeWindowsPowerShell(buildWindowsServicePowerShell(launch)))
}

/** Match an unguessable, persisted command-line identity, never just a PID or port. */
export function isManagedAppCommand(command: string, deployment: UpdateDeployment, status: UpdateRunnerStatus) {
  return status.secret.length >= 32 && status.instance.length >= 32
    && command.includes(deployment.controller) && command.includes(deployment.root)
    && command.includes(status.secret) && command.includes(status.instance)
    && /(?:^|[\s"])app(?:[\s"]|$)/.test(command)
}

async function matchingPids(deployment: UpdateDeployment, status: UpdateRunnerStatus) {
  if (deployment.platform === "win32") {
    const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine) -Compress'
    const result = await runServiceCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeWindowsPowerShell(script)])
    assertCommandSucceeded("Inspect managed processes", result)
    const processes = JSON.parse(result.stdout.replace(/^\uFEFF/, "")) as { ProcessId: number; CommandLine: string | null }[]
    return processes.filter((p) => isManagedAppCommand(p.CommandLine ?? "", deployment, status)).map((p) => p.ProcessId)
  }
  const result = await runServiceCommand("/bin/ps", ["-axo", "pid=,command="])
  assertCommandSucceeded("Inspect managed processes", result)
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    return match && isManagedAppCommand(match[2], deployment, status) ? [Number(match[1])] : []
  })
}

export async function stopOrphanedApp(deployment: UpdateDeployment, status: UpdateRunnerStatus) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const pids = await matchingPids(deployment, status)
    if (!pids.length) return
    if (pids.length !== 1) throw new Error("Multiple processes claim the application identity; recovery needs inspection.")
    // Re-discover identity on every retry, including before escalating the signal.
    try { process.kill(pids[0], Date.now() + 2_000 >= deadline ? "SIGKILL" : "SIGTERM") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    if (Date.now() > deadline) throw new Error("An identified application process did not exit; data stays untouched.")
    await Bun.sleep(250)
  }
}
