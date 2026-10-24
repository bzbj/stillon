import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeModelPolicySchema, claudeModelSelectionSchema, type ClaudeModelDraft, type ClaudeModelPolicy, type ClaudeModelPolicySnapshot } from "../shared/claude-model-policy"
import { BUNDLED_CLAUDE_MODEL_POLICY } from "../shared/types"
import { applyServerClaudeModelPolicy } from "./provider-catalog"
import { resolveClaudeCodeExecutable } from "./claude-executable"
import { inheritClaudeAgentEnvironment } from "./agent-environment"

export interface ClaudeDiscoveredModel {
  value: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
}
export interface ClaudeModelDiscoveryOptions {
  discover?: () => Promise<ClaudeDiscoveredModel[]>
  getEnvironment?: () => NodeJS.ProcessEnv
}

/** Metadata only: the stream never yields a user message, so no turn is started. */
export async function discoverClaudeModels(environment: NodeJS.ProcessEnv): Promise<ClaudeDiscoveredModel[]> {
  let finish!: () => void
  const stopped = new Promise<void>((resolve) => { finish = resolve })
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await stopped })()
  const q = query({ prompt, options: {
    cwd: homedir(), tools: [], systemPrompt: "", persistSession: false,
    settingSources: ["user"], pathToClaudeCodeExecutable: resolveClaudeCodeExecutable({ environment }),
    env: inheritClaudeAgentEnvironment(environment),
  } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude model discovery timed out. Check the CLI installation and sign-in, then retry or add a model ID manually.")), 20_000) }),
    ])
  } finally { clearTimeout(timer); finish(); q.close() }
}

export class ClaudeModelPolicyManager {
  private policy = structuredClone(BUNDLED_CLAUDE_MODEL_POLICY)
  private warning: string | null = null
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private discovery: Promise<ClaudeModelDraft> | null = null
  readonly filePath: string
  constructor(dataDir: string, private options: ClaudeModelDiscoveryOptions = {}) {
    this.filePath = path.join(dataDir, "claude-model-policy.json")
  }
  get busy() { return this.discovery !== null }
  async close() { await Promise.allSettled([this.queue, ...(this.discovery ? [this.discovery] : [])]) }
  async initialize() {
    try {
      const file = JSON.parse(await readFile(this.filePath, "utf8"))
      if (file.schemaVersion !== 1) throw new Error("Unsupported Claude model configuration version")
      this.policy = claudeModelPolicySchema.parse(file.policy)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warning = "Unable to read saved Claude models; using bundled models. Save a valid configuration to recover."
    }
    applyServerClaudeModelPolicy(this.policy)
  }
  getSnapshot(): ClaudeModelPolicySnapshot {
    return { revision: createHash("sha256").update(JSON.stringify(this.policy)).digest("hex"), policy: structuredClone(this.policy), warning: this.warning }
  }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  discover(): Promise<ClaudeModelDraft> {
    if (this.discovery) return this.discovery
    const snapshot = this.getSnapshot()
    this.discovery = (async () => {
      const discovered = await (this.options.discover?.() ?? discoverClaudeModels(this.options.getEnvironment?.() ?? process.env))
      if (!discovered.length || discovered.length > 100) throw new Error("Claude returned an empty or oversized model list. Add a supported model ID manually or retry after checking the CLI.")
      const models = structuredClone(snapshot.policy.models)
      for (const candidate of discovered) {
        const id = candidate.resolvedModel || candidate.value
        // Only an exact ID/alias match is safe: family matching can replace a new model with an older version.
        const index = models.findIndex((model) => model.id === id || model.aliases?.includes(id))
        const previous = index < 0 ? undefined : models[index]
        const model = {
          ...previous, id: previous?.id ?? id,
          label: candidate.displayName?.trim() || previous?.label || id,
          description: candidate.description ?? previous?.description,
          supportsEffort: candidate.supportsEffort ?? previous?.supportsEffort ?? false,
          supportsMaxReasoningEffort: candidate.supportedEffortLevels?.includes("max") ?? previous?.supportsMaxReasoningEffort ?? false,
        }
        if (index >= 0) models[index] = model
        else models.push(model)
      }
      // Alias rows may resolve to the same canonical ID; validate the merged catalog once.
      const policy = claudeModelPolicySchema.parse({ models, defaultModel: snapshot.policy.defaultModel })
      return { models: policy.models, baseRevision: snapshot.revision }
    })().finally(() => { this.discovery = null })
    return this.discovery
  }
  apply(value: unknown): Promise<ClaudeModelPolicySnapshot> {
    const operation = this.queue.then(async () => {
      const selection = claudeModelSelectionSchema.parse(value)
      if (selection.baseRevision !== this.getSnapshot().revision) throw new Error("Claude model configuration changed on another device. Reload the configuration before saving.")
      const policy: ClaudeModelPolicy = selection.policy
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, policy }, null, 2) + "\n", { mode: 0o600 })
        await rename(temporary, this.filePath)
      } finally { await rm(temporary, { force: true }) }
      this.policy = policy
      this.warning = null
      applyServerClaudeModelPolicy(policy)
      for (const listener of this.listeners) listener()
      return this.getSnapshot()
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
