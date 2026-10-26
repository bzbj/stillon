import { spawn } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

export interface CliInstallerLifecycle { onSpawn?: (pid: number) => Promise<void> }

/** Never interrupt a package manager while it is mutating the user's CLI.
 * Discard streams instead of execFile's maxBuffer, which also kills on overflow.
 * Version checks and metadata requests retain their short, bounded timeouts.
 */
export async function runCliInstaller(command: string, args: string[], env: NodeJS.ProcessEnv, lifecycle: CliInstallerLifecycle = {}) {
  if (process.platform === "win32" && /\.(cmd|bat)$/iu.test(command)) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const script = `& ${[command, ...args].map(quote).join(" ")}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
    command = path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
  }
  const child = spawn(command, args, { env, windowsHide: true, cwd: env.HOME || env.USERPROFILE || homedir(), stdio: "ignore" })
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve()
      else reject(Object.assign(new Error("The CLI installer did not finish successfully."), { code, signal }))
    })
  })
  // Attach a handler before persisting the PID so an early exit is never unhandled.
  const outcome = finished.then(() => undefined, error => error)
  let journalError: unknown
  if (child.pid) {
    try { await lifecycle.onSpawn?.(child.pid) } catch (error) { journalError = error }
  }
  const error = await outcome
  // A journal write failure must not kill an already-running installer either.
  if (error || journalError) throw error ?? journalError
}
