import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { AgentProvider } from "../shared/types"
import { findCliExecutable } from "./cli-environment"
import { resolveLocalPath } from "./paths"

export class ProviderCliSettings {
  readonly filePath: string
  private last: Partial<Record<AgentProvider, string>> = {}
  private pending: Promise<void> = Promise.resolve()
  constructor(dataDir: string) { this.filePath = path.join(dataDir, "provider-cli.json") }
  private read() {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"))
      if (raw.schemaVersion !== 1) return this.last
      this.last = Object.fromEntries(["codex", "claude"].filter(key => typeof raw[key] === "string" && !/[\u0000\r\n]/u.test(raw[key])).map(key => [key, raw[key]]))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.last = {} }
    return this.last
  }
  environment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const configured = this.read()
    return { ...environment, ...(configured.codex ? { CODEX_EXECUTABLE: configured.codex } : {}), ...(configured.claude ? { CLAUDE_EXECUTABLE: configured.claude } : {}) }
  }
  set(provider: AgentProvider, input: string | null) {
    const operation = this.pending.then(() => this.write(provider, input))
    this.pending = operation.catch(() => {})
    return operation
  }
  private async write(provider: AgentProvider, input: string | null) {
    const configured = { ...this.read() }
    if (input === null) delete configured[provider]
    else {
      if (typeof input !== "string" || /[\u0000\r\n]/u.test(input)) throw new Error("Choose a valid CLI executable path.")
      const resolved = resolveLocalPath(input)
      if (!findCliExecutable(resolved)) throw new Error("The selected CLI file is missing or is not executable.")
      configured[provider] = resolved
    }
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...configured }, null, 2) + "\n", { mode: 0o600 })
    await rename(temporary, this.filePath)
    this.last = configured
  }
}
