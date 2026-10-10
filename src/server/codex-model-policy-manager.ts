import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  BUNDLED_CODEX_MODEL_POLICY,
  codexModelPolicyFileSchema,
  type CodexModelPolicy,
  type CodexModelPolicySnapshot,
} from "../shared/codex-model-policy"
import { applyServerCodexModelPolicy } from "./provider-catalog"

interface PolicyJournal {
  schemaVersion: 1
  current: CodexModelPolicy
  previous: CodexModelPolicy | null
}

async function atomicJson(filePath: string, value: unknown) {
  return atomicText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicText(filePath: string, text: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true })
  }
}

function parsePolicy(value: unknown) {
  return codexModelPolicyFileSchema.parse({ schemaVersion: 1, policy: value }).policy
}

function revision(policy: CodexModelPolicy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex")
}

/** One serialized writer owns configuration acceptance and its recovery journal. */
export class CodexModelPolicyManager {
  readonly filePath: string
  private readonly journalPath: string
  private current = structuredClone(BUNDLED_CODEX_MODEL_POLICY)
  private previous: CodexModelPolicy | null = null
  private source: CodexModelPolicySnapshot["source"] = "builtin"
  private warning: string | null = null
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "codex-model-policy.json")
    this.journalPath = path.join(dataDir, "codex-model-policy-state.json")
  }

  async initialize() {
    let recoveryWarning: string | null = null
    try {
      const saved = JSON.parse(await readFile(this.journalPath, "utf8")) as PolicyJournal
      if (saved.schemaVersion !== 1) throw new Error("Unsupported recovery schema version")
      this.current = parsePolicy(saved.current)
      this.previous = saved.previous === null ? null : parsePolicy(saved.previous)
      this.source = "last-good"
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        recoveryWarning = "Saved model policy could not be read; using the bundled policy."
        this.current = structuredClone(BUNDLED_CODEX_MODEL_POLICY)
        this.previous = null
      }
    }
    try {
      const local = codexModelPolicyFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))).policy
      await this.accept(local, "local")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warning = `Model configuration rejected; keeping ${this.source} policy. ${this.describeError(error)}`
      } else {
        this.warning = recoveryWarning
        try {
          await atomicJson(this.filePath, { schemaVersion: 1, policy: this.current })
        } catch (writeError) {
          this.warning = `Could not create the local model configuration. ${this.describeError(writeError)}`
        }
      }
      applyServerCodexModelPolicy(this.current)
    }
  }

  getSnapshot(): CodexModelPolicySnapshot {
    return {
      schemaVersion: 1,
      revision: revision(this.current),
      policy: structuredClone(this.current),
      source: this.source,
      filePath: this.filePath,
      warning: this.warning,
      canRestore: this.previous !== null,
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  refresh() {
    return this.serialize(async () => {
      // A missing/invalid override is an error during explicit refresh. Restoring
      // bundled defaults is an intentional, separate operation.
      const file = codexModelPolicyFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")))
      await this.accept(file.policy, "local")
      return this.getSnapshot()
    })
  }

  restore(target: "previous" | "builtin") {
    return this.serialize(async () => {
      if (target !== "previous" && target !== "builtin") throw new Error("Unknown model policy restore target")
      if (target === "previous" && !this.previous) throw new Error("No previous model configuration is available")
      const policy = structuredClone(target === "previous" ? this.previous! : BUNDLED_CODEX_MODEL_POLICY)
      // Also replace the local override, so a restart does not reactivate the
      // rejected configuration. Save recovery state before publishing in memory.
      let priorFile: string | null = null
      try { priorFile = await readFile(this.filePath, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      await atomicJson(this.filePath, { schemaVersion: 1, policy })
      try {
        await this.accept(policy, target === "builtin" ? "builtin" : "local")
      } catch (error) {
        // A failed journal write must not change what the next startup accepts.
        if (priorFile === null) await rm(this.filePath, { force: true })
        else await atomicText(this.filePath, priorFile)
        throw error
      }
      return this.getSnapshot()
    })
  }

  private async accept(value: CodexModelPolicy, source: CodexModelPolicySnapshot["source"]) {
    const policy = parsePolicy(value)
    const changed = revision(policy) !== revision(this.current)
    const previous = changed ? this.current : this.previous
    await atomicJson(this.journalPath, { schemaVersion: 1, current: policy, previous } satisfies PolicyJournal)
    this.previous = structuredClone(previous)
    this.current = policy
    this.source = source
    this.warning = null
    applyServerCodexModelPolicy(policy)
    this.emit()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation).catch((error: unknown) => {
      this.warning = `Model configuration rejected; keeping the active policy. ${this.describeError(error)}`
      this.emit()
      throw new Error(this.warning)
    })
    this.pending = next.catch(() => undefined)
    return next
  }

  private describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}
