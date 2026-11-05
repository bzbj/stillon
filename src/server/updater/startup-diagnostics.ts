import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises"
import path from "node:path"
import { atomicJson, assertPlainDirectory, json } from "./files"

interface ApplicationExit { runtime: string; exitCode: number | null; stderrLog?: string; at: string }
const logName = /^[a-zA-Z0-9_-]{1,80}\.stderr\.log$/
export const APPLICATION_LOG_BYTES = 64 * 1024
export const APPLICATION_LOG_COUNT = 8

export function applicationLogPath(root: string, instance: string) {
  const name = `${instance}.stderr.log`
  if (!logName.test(name)) throw new Error("Invalid managed application log identity.")
  return path.join(root, "application-logs", name)
}

async function pruneLogs(root: string, active: string) {
  const directory = path.join(root, "application-logs")
  const entries = await Promise.all((await readdir(directory)).filter(name => logName.test(name)).map(async name => {
    const info = await lstat(path.join(directory, name))
    return { name, info }
  }))
  const logs = entries.filter(({ info }) => info.isFile()).sort((a, b) => a.name === active ? -1 : b.name === active ? 1 : b.info.mtimeMs - a.info.mtimeMs)
  // Keep the logs cited by the active transaction even during a crash loop.
  const state = await json<{ error?: string; recoveryError?: string }>(path.join(root, "state.json")).catch(() => null)
  const errors = [state?.error, state?.recoveryError].filter(value => typeof value === "string").join(" ")
  for (const { name } of logs.slice(APPLICATION_LOG_COUNT)) {
    if (!errors.includes(name)) await unlink(path.join(directory, name))
  }
}

/** Drain stderr even if logging fails, with bounded memory and disk usage. */
export function captureApplicationStderr(root: string, instance: string, stream: ReadableStream<Uint8Array>) {
  const file = applicationLogPath(root, instance)
  const reader = stream.getReader()
  const finished = (async () => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await assertPlainDirectory(path.dirname(file))
        handle = await open(file, "wx", 0o600)
        await pruneLogs(root, path.basename(file))
      } catch { /* Diagnostics must not prevent application startup. */ }
      let tail = Buffer.alloc(0)
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!handle) continue
        tail = Buffer.concat([tail, value.subarray(Math.max(0, value.length - APPLICATION_LOG_BYTES))]).subarray(-APPLICATION_LOG_BYTES)
        try {
          // Explicit offsets also work on Windows; append handles cannot be truncated there.
          let offset = 0
          while (offset < tail.length) {
            const { bytesWritten } = await handle.write(tail, offset, tail.length - offset, offset)
            if (!bytesWritten) throw new Error("Unable to write application diagnostics.")
            offset += bytesWritten
          }
          await handle.truncate(tail.length)
        } catch { await handle.close().catch(() => {}); handle = undefined }
      }
    } finally {
      await handle?.close().catch(() => {})
      reader.releaseLock()
    }
  })().catch(() => {})
  return { file, finished, async finish() {
    // Descendants can inherit stderr and outlive the app; never hold up recovery.
    await Promise.race([finished, Bun.sleep(1_000)])
    await reader.cancel().catch(() => {})
    await finished
  } }
}

export async function recordApplicationExit(root: string, runtime: string, exitCode: number | null, stderrLog?: string) {
  await atomicJson(path.join(root, "application-exit.json"), { runtime, exitCode, stderrLog, at: new Date().toISOString() } satisfies ApplicationExit)
}

// Keep raw application output local: it can contain paths or credentials.
// Malformed diagnostics must not mask a health failure or expose their contents.
export async function applicationFailure(root: string, runtime: string): Promise<string | null> {
  try {
    const exit = await json<ApplicationExit>(path.join(root, "application-exit.json"))
    if (exit.runtime !== runtime) return null
    let detail = "", log = ""
    if (typeof exit.stderrLog === "string" && logName.test(path.basename(exit.stderrLog))) {
      const name = path.basename(exit.stderrLog)
      const expected = path.join(root, "application-logs", name)
      if (path.resolve(exit.stderrLog) === path.resolve(expected)) {
        log = `; see application-logs/${name}`
        try {
          await assertPlainDirectory(path.dirname(expected))
          if ((await lstat(expected)).isFile()) {
            const file = Bun.file(expected)
            const output = await file.slice(Math.max(0, file.size - 16 * 1024)).text()
            if (/\bEADDRINUSE\b/.test(output)) detail = " (EADDRINUSE: the configured port is still in use)"
            else if (/\bEACCES\b|\bEPERM\b/.test(output)) detail = " (permission denied)"
          }
        } catch { /* The exit code is still useful when its log is unavailable. */ }
      }
    }
    const code = Number.isInteger(exit.exitCode) ? exit.exitCode : "unknown"
    return `application exited with code ${code}${detail}${log}`
  } catch { return null }
}
