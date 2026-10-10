import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  BUNDLED_CODEX_MODEL_POLICY,
  codexModelPolicyFileSchema,
  type CodexModelPolicy,
  type CodexModelPolicySnapshot,
  type CodexModelSelectionDraft,
  type CodexModelSelection,
} from "../shared/codex-model-policy"
import { applyServerCodexModelPolicy } from "./provider-catalog"
import { inheritAgentEnvironment } from "./agent-environment"
import { codexDiscoveryContext, discoverCodexModels, type CodexModelDiscoveryResult } from "./codex-model-discovery"

export interface CodexModelDiscoveryOptions {
  now?: () => number
  getEnvironment?: () => NodeJS.ProcessEnv
  discover?: () => Promise<CodexModelDiscoveryResult>
  getContext?: () => Promise<string>
}

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
  private discovery: Promise<CodexModelSelectionDraft> | null = null
  private drafts = new Map<string, { draft: CodexModelSelectionDraft; context: string }>()
  private closed = false

  constructor(dataDir: string, private readonly discoveryOptions: CodexModelDiscoveryOptions = {}) {
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

  get busy() { return this.discovery !== null || this.operations > 0 }
  private operations = 0

  async close() {
    this.closed = true
    await Promise.allSettled([this.discovery, this.pending])
    this.drafts.clear()
  }

  private discoveryContext() {
    return this.discoveryOptions.getContext?.() ?? codexDiscoveryContext(
      this.discoveryOptions.getEnvironment?.() ?? inheritAgentEnvironment(),
    )
  }

  private now() { return this.discoveryOptions.now?.() ?? Date.now() }

  discover(): Promise<CodexModelSelectionDraft> {
    if (this.closed) return Promise.reject(new Error("Model configuration is shutting down"))
    if (this.discovery) return this.discovery.then((draft) => structuredClone(draft))
    const operation = this.fetchDraft()
    this.discovery = operation
    void operation.finally(() => { this.discovery = null }).catch(() => {})
    return operation.then((draft) => structuredClone(draft))
  }

  private async fetchDraft(): Promise<CodexModelSelectionDraft> {
    const context = await this.discoveryContext()
    const base = this.getSnapshot()
    const result = await (this.discoveryOptions.discover?.() ?? discoverCodexModels({
      environment: this.discoveryOptions.getEnvironment?.() ?? inheritAgentEnvironment(),
    }))
    if (context !== await this.discoveryContext()) throw new Error("Codex account or CLI changed during discovery. Fetch models again.")
    if (base.revision !== this.getSnapshot().revision) throw new Error("Model configuration changed during discovery. Fetch models again.")
    const warnings: string[] = []
    const candidates: CodexModelSelectionDraft["candidates"] = result.models.map((entry) => {
      const existing = base.policy.models.find((model) => model.id === entry.model)
      const efforts = entry.supportedReasoningEfforts.map((effort) => effort.reasoningEffort)
      const recognized = [...new Set(efforts.filter((effort): effort is "low" | "medium" | "high" | "xhigh" | "max" | "ultra" =>
        ["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)))]
      const unknown = efforts.filter((effort) => !recognized.includes(effort as typeof recognized[number]))
      if (unknown.length) warnings.push(`${entry.displayName}: unsupported reasoning options omitted (${unknown.join(", ")}).`)
      const disabledReason = entry.inputModalities && !entry.inputModalities.includes("text")
        ? "This model does not support text input in StillOn."
        : !recognized.length ? "This model does not provide reasoning options this StillOn version supports." : undefined
      return {
        available: true, ...(disabledReason ? { disabledReason } : {}),
        model: { id: entry.model, label: entry.displayName,
          ...(entry.description ? { description: entry.description } : {}),
          ...(existing?.aliases ? { aliases: existing.aliases } : {}),
          supportsEffort: recognized.length > 0,
          supportedReasoningEfforts: recognized.length ? recognized : ["low"],
          supportsFastMode: existing?.supportsFastMode ?? false,
        },
      }
    })
    for (const model of base.policy.models) {
      if (!candidates.some((candidate) => candidate.model.id === model.id)) candidates.push({ available: false, model: structuredClone(model) })
    }
    if (!candidates.some((candidate) => candidate.available && !candidate.disabledReason)) {
      throw new Error("Codex returned no models compatible with this StillOn version. Current models are unchanged.")
    }
    const now = this.now()
    const draft: CodexModelSelectionDraft = {
      id: randomUUID(), baseRevision: base.revision, fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(), cliVersion: result.cliVersion, candidates,
      selectedModelIds: base.policy.models.filter((model) => !candidates.find((candidate) => candidate.model.id === model.id)?.disabledReason).map((model) => model.id),
      roles: base.policy.roles, warnings,
    }
    for (const [id, saved] of this.drafts) if (Date.parse(saved.draft.expiresAt) <= now) this.drafts.delete(id)
    if (this.drafts.size >= 8) this.drafts.delete(this.drafts.keys().next().value!)
    this.drafts.set(draft.id, { draft: structuredClone(draft), context })
    return draft
  }

  applySelection(selection: CodexModelSelection) {
    return this.serialize(async () => {
      const saved = this.drafts.get(selection?.draftId)
      if (!saved || Date.parse(saved.draft.expiresAt) <= this.now()) throw new Error("Model selection expired. Fetch models again.")
      if (saved.draft.baseRevision !== revision(this.current)) throw new Error("Model configuration changed. Fetch models again before confirming.")
      if (saved.context !== await this.discoveryContext()) throw new Error("Codex account or CLI changed. Fetch models again before confirming.")
      if (!Array.isArray(selection.modelIds) || !selection.modelIds.length
        || new Set(selection.modelIds).size !== selection.modelIds.length) throw new Error("Select at least one model; selections must be unique.")
      const models = selection.modelIds.map((id) => {
        const candidate = saved.draft.candidates.find((candidate) => candidate.model.id === id)
        if (!candidate || candidate.disabledReason) throw new Error("Selection contains an unavailable or incompatible model.")
        // A newly selected canonical ID takes priority over an older alias.
        return { ...candidate.model, ...(candidate.model.aliases ? {
          aliases: candidate.model.aliases.filter((alias) => !selection.modelIds.includes(alias)),
        } : {}) }
      })
      const policy = parsePolicy({ models, roles: selection.roles })
      await this.replaceLocal(policy, "local")
      this.drafts.delete(selection.draftId)
      return this.getSnapshot()
    })
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
      await this.replaceLocal(policy, target === "builtin" ? "builtin" : "local")
      return this.getSnapshot()
    })
  }

  private async replaceLocal(policy: CodexModelPolicy, source: CodexModelPolicySnapshot["source"]) {
    // Persist the confirmed configuration; undo the editable file on journal failure.
    let priorFile: string | null = null
    try { priorFile = await readFile(this.filePath, "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await atomicJson(this.filePath, { schemaVersion: 1, policy })
    try {
      await this.accept(policy, source)
    } catch (error) {
      // A failed journal write must not change what the next startup accepts.
      if (priorFile === null) await rm(this.filePath, { force: true })
      else await atomicText(this.filePath, priorFile)
      throw error
    }
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
    if (this.closed) return Promise.reject(new Error("Model configuration is shutting down"))
    this.operations++
    const next = this.pending.then(operation).catch((error: unknown) => {
      this.warning = `Model configuration rejected; keeping the active policy. ${this.describeError(error)}`
      this.emit()
      throw new Error(this.warning)
    }).finally(() => { this.operations-- })
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
