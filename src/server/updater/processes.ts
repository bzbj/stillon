import { runServiceCommand } from "../service"
import { assertCommandSucceeded } from "../service/types"
import { encodeWindowsPowerShell } from "../service/windows"
import type { UpdateDeployment, UpdateRunnerStatus } from "./model"

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
