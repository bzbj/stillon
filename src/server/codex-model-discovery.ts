import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { APP_NAME, APP_VERSION } from "../shared/branding"
import { getCodexCliCommand } from "./codex-cli-command"

const modelSchema = z.object({
  id: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  description: z.string().max(4096).optional(),
  hidden: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().max(64) })).max(32),
  inputModalities: z.array(z.string()).optional(),
})
const pageSchema = z.object({ data: z.array(modelSchema).max(2000), nextCursor: z.string().min(1).max(4096).nullable() })
export type DiscoveredCodexModel = z.infer<typeof modelSchema>
export interface CodexModelDiscoveryResult { models: DiscoveredCodexModel[]; cliVersion: string }

function discoveryHome(environment: NodeJS.ProcessEnv) {
  return environment.HOME || environment.USERPROFILE || homedir()
}

export function resolveCodexDiscoveryHome(environment: NodeJS.ProcessEnv) {
  return environment.CODEX_HOME || path.join(discoveryHome(environment), ".codex")
}

/** Isolated metadata connection: never start/resume a thread or request inference. */
export async function discoverCodexModels(options: {
  environment: NodeJS.ProcessEnv
  timeoutMs?: number
  spawnProcess?: () => ChildProcessWithoutNullStreams
}): Promise<CodexModelDiscoveryResult> {
  const child = options.spawnProcess?.() ?? spawn(getCodexCliCommand(process.platform, options.environment), ["app-server"], {
    cwd: discoveryHome(options.environment), env: options.environment, stdio: ["pipe", "pipe", "pipe"],
  })
  let buffer = "", totalBytes = 0, serial = 0
  let closed = false
  let failed: Error | null = null
  let pending: { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null
  function fail(message: string) {
    failed ??= new Error(message)
    pending?.reject(failed)
    pending = null
    child.kill()
  }
  const timeout = setTimeout(() => fail("Codex model discovery timed out. Current models are unchanged."), options.timeoutMs ?? 20_000)
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => { closed = true; fail("Codex model discovery connection closed."); resolve() })
  })
  child.on("error", () => fail("Could not start Codex CLI. Check its installation and service PATH."))
  child.stdin.on("error", () => fail("Could not write to Codex model discovery connection."))
  // Drain diagnostics without forwarding credentials or upstream response bodies.
  child.stderr.on("data", () => {})
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    totalBytes += Buffer.byteLength(chunk)
    buffer += chunk
    if (totalBytes > 16 * 1024 * 1024 || buffer.length > 2 * 1024 * 1024) return fail("Codex model discovery response was too large.")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: any
      try { message = JSON.parse(line) } catch { fail("Codex model discovery returned invalid JSON."); return }
      if (!message || typeof message !== "object") { fail("Codex model discovery returned an invalid response."); return }
      if (message.method && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Metadata client does not handle server requests" } })}\n`)
      } else if (pending && message.id === pending.id) {
        const request = pending
        pending = null
        if (message.error) request.reject(new Error("Codex rejected model discovery. Check your CLI version and account."))
        else if (!("result" in message)) request.reject(new Error("Codex model discovery result is missing."))
        else request.resolve(message.result)
      }
    }
  })
  function request(method: string, params: unknown) {
    if (failed) return Promise.reject(failed)
    return new Promise<unknown>((resolve, reject) => {
      const id = ++serial
      pending = { id, resolve, reject }
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }
  try {
    const initialization = await request("initialize", {
      clientInfo: { name: "stillon", title: APP_NAME, version: APP_VERSION }, capabilities: { experimentalApi: true },
    }) as { userAgent?: string }
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
    const models: DiscoveredCodexModel[] = []
    const cursors = new Set<string>()
    const names = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 50; page++) {
      const result = pageSchema.safeParse(await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }))
      if (!result.success) throw new Error("Codex model discovery returned an incompatible catalog. Current models are unchanged.")
      for (const model of result.data.data) {
        if (model.hidden) continue
        if (names.has(model.model)) throw new Error("Codex model discovery returned duplicate model IDs.")
        names.add(model.model)
        models.push(model)
      }
      if (models.length > 2000) throw new Error("Codex model discovery returned too many models.")
      cursor = result.data.nextCursor
      if (cursor === null) {
        if (!models.length) throw new Error("Codex returned an empty catalog. Current models are unchanged.")
        return { models, cliVersion: typeof initialization?.userAgent === "string"
          ? initialization.userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? "unknown" : "unknown" }
      }
      if (cursors.has(cursor)) throw new Error("Codex model discovery repeated a pagination cursor.")
      cursors.add(cursor)
    }
    throw new Error("Codex model discovery exceeded its pagination limit.")
  } finally {
    clearTimeout(timeout)
    if (!closed) {
      child.stdin.end()
      child.kill()
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1000)
      await exited
      clearTimeout(forceKill)
    }
  }
}

/** Hash context, never return account files or environment values to clients. */
export async function codexDiscoveryContext(environment: NodeJS.ProcessEnv) {
  const hash = createHash("sha256")
  hash.update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
  const command = Bun.which(getCodexCliCommand(process.platform, environment), { PATH: environment.PATH })
  if (command) {
    const info = await stat(command)
    hash.update(JSON.stringify([command, info.size, info.mtimeMs, info.ino]))
  }
  const home = resolveCodexDiscoveryHome(environment)
  for (const file of ["auth.json", "config.toml"]) {
    try { hash.update(await readFile(path.join(home, file))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not verify Codex discovery context.") }
  }
  return hash.digest("hex")
}
