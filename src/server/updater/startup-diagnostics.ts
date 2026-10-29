import path from "node:path"
import { atomicJson, exists, inside, json } from "./files"

interface ApplicationExit { runtime: string; exitCode: number | null; stderrLog?: string; at: string }

export async function recordApplicationExit(root: string, runtime: string, exitCode: number | null, stderrLog?: string) {
  await atomicJson(path.join(root, "application-exit.json"), { runtime, exitCode, stderrLog, at: new Date().toISOString() } satisfies ApplicationExit)
}

// Keep raw application output local: it can contain paths or credentials.
// Only known error codes and a managed relative log path enter update status.
export async function applicationFailure(root: string, runtime: string): Promise<string | null> {
  const file = path.join(root, "application-exit.json")
  if (!await exists(file)) return null
  const exit = await json<ApplicationExit>(file)
  if (exit.runtime !== runtime) return null
  let detail = ""
  let log = ""
  if (exit.stderrLog) {
    const relative = path.relative(root, exit.stderrLog)
    const safeFile = inside(root, relative)
    const logFile = Bun.file(safeFile)
    const output = await logFile.slice(Math.max(0, logFile.size - 16 * 1024)).text().catch(() => "")
    if (/\bEADDRINUSE\b/.test(output)) detail = " (EADDRINUSE: the configured port is still in use)"
    else if (/\bEACCES\b|\bEPERM\b/.test(output)) detail = " (permission denied)"
    log = `; see ${relative}`
  }
  return `application exited with code ${exit.exitCode ?? "unknown"}${detail}${log}`
}
