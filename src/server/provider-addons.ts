import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { ADDON_API, BUNDLED_INTEGRATIONS, MAX_ADDON_BYTES, addonManifestSchema, type AddonManifest, type AddonPackage, type AddonSnapshot } from "../shared/provider-addons"
import type { AgentProvider, ProviderCatalogEntry } from "../shared/types"
import { isAddonProvider } from "../shared/types"
import type { ProviderSetupStatus } from "../shared/provider-setup"
import { AddonProcess, addonTurn, type AddonTurnArgs } from "./addon-process"
import { harnessPolicySchema, harnessModelSchema, harnessSelectionSchema, type HarnessModel, type HarnessModelPolicy } from "../shared/harness-models"

type Installation = { version: string; enabled: boolean; previousVersion?: string }
type RecordEntry = { installation: Installation; manifest?: AddonManifest; error?: string }
const hash = (code: string) => createHash("sha256").update(code).digest("hex")
const safeVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value)

export function parseAddonPackage(value: unknown): AddonPackage {
  const input = value as AddonPackage
  const manifest = addonManifestSchema.parse(input?.manifest)
  if (typeof input?.code !== "string" || Buffer.byteLength(input.code) > MAX_ADDON_BYTES || hash(input.code) !== manifest.sha256) throw new Error("Invalid add-on package checksum or size.")
  return { manifest, code: input.code }
}

export class ProviderAddons {
  private records = new Map<string, RecordEntry>()
  private leases = new Map<string, number>()
  private mutating = false
  private loadError?: string
  private modelPolicies = new Map<string, HarnessModelPolicy>()
  private modelErrors = new Map<string, string>()
  private discovered = new Map<string, Map<string, HarnessModel>>()
  private bundled = new Set<string>()
  private bundleErrors = new Map<string, string>()
  readonly root: string
  constructor(dataDir: string, private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
    private readonly changed: () => void = () => {}) { this.root = path.resolve(dataDir, "addons") }

  async initialize(bundledDirectory?: string) {
    try {
      const saved = JSON.parse(await readFile(path.join(this.root, "installed.json"), "utf8"))
      if (saved.schema !== 1 || !saved.installations || typeof saved.installations !== "object") throw new Error("Invalid add-on registry.")
      for (const [id, installation] of Object.entries(saved.installations) as [string, Installation][]) {
        if (id === "codebuddy") continue
        if (!isAddonProvider(id) || !installation || !safeVersion(installation.version) || typeof installation.enabled !== "boolean"
          || (installation.previousVersion !== undefined && !safeVersion(installation.previousVersion))) throw new Error("Invalid add-on registry entry.")
        const record: RecordEntry = { installation }
        try { record.manifest = (await this.readPackage(id, installation.version)).manifest; record.error = this.compatibility(record.manifest) }
        catch { record.error = "The installed package is missing or damaged. Reinstall the add-on." }
        this.records.set(id, record)
        await this.loadModelPolicy(id)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.records.clear(); this.loadError = "The add-on registry is damaged. Restore its backup before changing packages."
      }
    }
    if (bundledDirectory && !this.loadError) await this.initializeBundled(bundledDirectory)
  }

  private async initializeBundled(directory: string) {
    // The running app selects the adapter version, including on app rollback.
    // Only the user's enabled flag and model policy live outside that runtime.
    for (const [id] of Object.entries(BUNDLED_INTEGRATIONS)) {
      this.bundled.add(id)
      try {
        const file = Bun.file(path.join(directory, `${id}.stillon-addon`))
        if (file.size > MAX_ADDON_BYTES * 2) throw new Error("Invalid bundled package size.")
        const bundle = parseAddonPackage(await file.json())
        if (bundle.manifest.id !== id) throw new Error("Bundled integration identity mismatch.")
        // Staging verifies bytes, but never launches an adapter or vendor CLI.
        await this.cachePackage(bundle)
        const previous = this.records.get(id)?.installation
        const installation: Installation = { version: bundle.manifest.version, enabled: previous?.enabled ?? false }
        const record = { manifest: bundle.manifest, installation, error: this.compatibility(bundle.manifest) }
        const records = new Map(this.records); records.set(id, record)
        if (JSON.stringify(previous) !== JSON.stringify(installation)) await this.save(records)
        else this.records = records
        if (!previous) await this.loadModelPolicy(id)
      } catch {
        this.bundleErrors.set(id, "This bundled integration is missing or damaged. Repair or update StillOn; your settings and chats are preserved.")
      }
    }
  }
  private async loadModelPolicy(id: string) {
    try { this.modelPolicies.set(id, harnessPolicySchema.parse(JSON.parse(await readFile(path.join(this.root, id, "models.json"), "utf8")))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.modelErrors.set(id, "The saved model list is damaged. Discover and save the enabled models again in Settings.") }
  }

  private compatibility(manifest: AddonManifest) {
    if (manifest.hostApi !== ADDON_API) return "This add-on needs a different StillOn add-on API version."
    if (!manifest.targets.includes(`${process.platform}-${process.arch}`)) return "This add-on has not been qualified for this platform."
    return undefined
  }
  private directory(id: string, version: string) {
    if (!isAddonProvider(id) || !safeVersion(version)) throw new Error("Invalid add-on identity.")
    return path.join(this.root, id, version)
  }
  private async readPackage(id: string, version: string) {
    const directory = this.directory(id, version)
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"))
    const code = await readFile(path.join(directory, "adapter.js"), "utf8")
    const bundle = parseAddonPackage({ manifest, code })
    if (bundle.manifest.id !== id || bundle.manifest.version !== version) throw new Error("Add-on identity mismatch.")
    return bundle
  }
  private async save(records: Map<string, RecordEntry>) {
    await mkdir(this.root, { recursive: true })
    const file = path.join(this.root, "installed.json"), temporary = path.join(this.root, `installed-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ schema: 1, installations: Object.fromEntries([...records].map(([id, record]) => [id, record.installation])) }) + "\n", { flag: "wx" })
    await rename(temporary, file)
    this.records = records; this.changed()
  }
  private async mutate<T>(id: string, operation: () => Promise<T>) {
    if (this.loadError) throw new Error(this.loadError)
    if (this.mutating || this.leases.get(id)) throw new Error("Wait for this add-on's work to finish, or stop its chats, before changing it.")
    this.mutating = true
    try { return await operation() } finally { this.mutating = false }
  }
  snapshot(): AddonSnapshot[] {
    if (this.loadError) return [{ id: "deepseek", name: "Provider add-ons", version: "unknown", enabled: false, compatible: false, busy: false, error: this.loadError }]
    return [...new Set([...this.bundled, ...this.records.keys()])].map(id => {
      const record = this.records.get(id), error = this.bundleErrors.get(id) ?? record?.error
      return { id, name: record?.manifest?.name ?? BUNDLED_INTEGRATIONS[id as keyof typeof BUNDLED_INTEGRATIONS] ?? id,
        version: record?.installation.version ?? "unavailable", enabled: record?.installation.enabled ?? false,
        compatible: Boolean(record?.manifest && !error), busy: Boolean(this.leases.get(id)), bundled: this.bundled.has(id),
        previousVersion: this.bundled.has(id) ? undefined : record?.installation.previousVersion, error }
    })
  }
  private catalog(manifest: AddonManifest): ProviderCatalogEntry {
    const policy = manifest.capabilities.modelManagement ? this.modelPolicies.get(manifest.id) : undefined
    return { ...manifest.catalog, ...(policy ? { models: policy.models.map(model => ({ ...model,
      efforts: [{ id: "default", label: "Harness default" }, ...model.efforts] })), defaultModel: policy.defaultModel, defaultEffort: "default" } : {}), capabilities: manifest.capabilities }
  }
  providers(): ProviderCatalogEntry[] { return [...this.records].filter(([id, record]) => record.installation.enabled && !record.error && !this.bundleErrors.has(id) && record.manifest).map(([, record]) => this.catalog(record.manifest!)) }
  getCatalog(provider: AgentProvider) { return this.catalog(this.require(provider)) }
  modelState(provider: AgentProvider) {
    const manifest = this.require(provider)
    if (!manifest.capabilities.modelManagement) throw new Error("Update this add-on to manage Harness models.")
    return { policy: this.modelPolicies.get(provider) ?? null, catalog: this.catalog(manifest), error: this.modelErrors.get(provider) }
  }
  async modelOperation(provider: AgentProvider, method: "configuration" | "discover" | "configure" | "fetchModels", params?: unknown) {
    this.modelState(provider)
    if (method === "configure" && this.leases.get(provider)) throw new Error("Stop this Harness's chats before changing its model service configuration.")
    const acquired = await this.acquire(provider, method === "configure")
    try {
      const result = await acquired.client.call(method, params, 130_000)
      if (method === "discover") {
        const models = harnessModelSchema.array().max(1000).parse(result)
        const candidates = this.discovered.get(provider) ?? new Map<string, HarnessModel>()
        for (const model of models) candidates.set(model.id, model)
        this.discovered.set(provider, candidates)
        return models
      }
      return result
    } finally {
      try { await acquired.client.close() } finally { acquired.release(); if (method === "configure") this.mutating = false }
    }
  }
  async selectModels(provider: AgentProvider, value: unknown) {
    this.modelState(provider)
    const input = harnessSelectionSchema.parse(value)
    return this.mutate(provider, async () => {
      const candidates = new Map(this.modelPolicies.get(provider)?.models.map(model => [model.id, model]))
      for (const [id, model] of this.discovered.get(provider) ?? []) candidates.set(id, model)
      const models = input.ids.map(id => {
        const model = candidates.get(id)
        if (!model) throw new Error("Discover this model before enabling it.")
        return model
      })
      const policy = harnessPolicySchema.parse({ schema: 1, models, defaultModel: input.defaultModel })
      const directory = path.join(this.root, provider)
      await mkdir(directory, { recursive: true })
      const temporary = path.join(directory, `models-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(policy) + "\n", { flag: "wx", mode: 0o600 })
      await rename(temporary, path.join(directory, "models.json"))
      this.modelPolicies.set(provider, policy); this.modelErrors.delete(provider); this.changed()
      return policy
    })
  }
  require(provider: AgentProvider) {
    const record = this.records.get(provider)
    if (!record?.manifest || !record.installation.enabled || record.error || this.loadError || this.bundleErrors.has(provider)) {
      throw new Error(this.bundleErrors.get(provider) ?? record?.error ?? this.loadError ?? "Enable DeepSeek Harness in Settings → Integrations to continue this chat.")
    }
    return record.manifest
  }
  async install(input: unknown) {
    const bundle = parseAddonPackage(input), { manifest, code } = bundle
    if (this.bundled.has(manifest.id)) throw new Error("This integration is included with StillOn. Update StillOn to update its adapter.")
    return this.mutate(manifest.id, async () => {
      const incompatible = this.compatibility(manifest)
      if (incompatible) throw new Error(incompatible)
      const directory = await this.cachePackage({ manifest, code })
      // Verify the protocol before publishing an active registry entry.
      const client = new AddonProcess(path.join(directory, "adapter.js"), this.environment())
      try { await this.handshake(client, manifest) } finally { await client.close() }
      const previous = this.records.get(manifest.id)?.installation
      const records = new Map(this.records)
      records.set(manifest.id, { manifest, installation: { version: manifest.version, enabled: previous?.enabled ?? true,
        previousVersion: previous?.version !== manifest.version ? previous?.version : previous?.previousVersion } })
      await this.save(records)
    })
  }
  private async cachePackage({ manifest, code }: AddonPackage) {
    const directory = this.directory(manifest.id, manifest.version)
    try {
      const existing = await this.readPackage(manifest.id, manifest.version)
      if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new Error("This package version already exists with different content. Use a new version.")
      return directory
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const staging = path.join(this.root, `.staging-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, "adapter.js"), code)
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest))
    await mkdir(path.dirname(directory), { recursive: true })
    await rename(staging, directory)
    return directory
  }
  async change(id: string, action: "enable" | "disable" | "uninstall" | "rollback") {
    return this.mutate(id, async () => {
      if (this.bundled.has(id) && action !== "enable" && action !== "disable") throw new Error("Bundled integrations update with StillOn. Disable the integration to hide it.")
      if (action === "enable" && this.bundleErrors.has(id)) throw new Error(this.bundleErrors.get(id))
      const current = this.records.get(id)
      if (!current) throw new Error("Add-on is not installed.")
      const records = new Map(this.records)
      if (action === "disable") records.set(id, { ...current, installation: { ...current.installation, enabled: false } })
      else if (action === "uninstall") records.delete(id)
      else {
        const version = action === "rollback" ? current.installation.previousVersion : current.installation.version
        if (!version) throw new Error("No previous version is available.")
        const manifest = (await this.readPackage(id, version)).manifest
        const error = this.compatibility(manifest)
        if (error) throw new Error(error)
        records.set(id, { manifest, error, installation: { version, enabled: action === "enable" ? true : current.installation.enabled,
          previousVersion: action === "rollback" ? current.installation.version : current.installation.previousVersion } })
      }
      // Keep immutable package versions as a reinstall/rollback cache; never touch chat or vendor data.
      await this.save(records)
    })
  }
  private async handshake(client: AddonProcess, manifest: AddonManifest) {
    const response = await client.call("hello", { api: ADDON_API })
    if (response?.api !== ADDON_API || response.id !== manifest.id || response.version !== manifest.version) throw new Error("The add-on protocol or package identity does not match.")
  }
  private async acquire(provider: AgentProvider, exclusive = false) {
    if (this.mutating) throw new Error("Wait for the add-on installation to finish.")
    const manifest = this.require(provider)
    if (exclusive) this.mutating = true
    this.leases.set(provider, (this.leases.get(provider) ?? 0) + 1)
    let released = false
    const release = () => { if (!released) { released = true; this.leases.set(provider, (this.leases.get(provider) ?? 1) - 1) } }
    let client: AddonProcess | undefined
    try {
      await this.readPackage(manifest.id, manifest.version)
      client = new AddonProcess(path.join(this.directory(manifest.id, manifest.version), "adapter.js"), this.environment())
      await this.handshake(client, manifest)
      return { client, manifest, release }
    } catch (error) { try { if (client) await client.close() } finally { release(); if (exclusive) this.mutating = false } throw error }
  }
  async status(provider: AgentProvider, local: boolean): Promise<ProviderSetupStatus> {
    let acquired: Awaited<ReturnType<ProviderAddons["acquire"]>> | undefined
    try {
      acquired = await this.acquire(provider)
      return await acquired.client.call("status", { local })
    } catch (error) { return { provider, platform: process.platform, canOpenTerminal: false, installed: false, state: "error",
      message: error instanceof Error ? error.message : "Add-on check failed." } }
    finally { if (acquired) { await acquired.client.close(); acquired.release() } }
  }
  async startTurn(provider: AgentProvider, args: AddonTurnArgs) {
    const manifest = this.require(provider)
    if (manifest.capabilities.modelManagement && this.modelErrors.has(provider)) throw new Error(this.modelErrors.get(provider))
    const catalog = this.catalog(manifest), model = catalog.models.find(model => model.id === args.model)
    if (args.sessionToken && !manifest.capabilities.resume) throw new Error("This add-on cannot resume an existing session.")
    if (!model) throw new Error("This model is not enabled. Select an enabled model or discover it in Settings.")
    if (args.effort && !(model.efforts ?? catalog.efforts).some(effort => effort.id === args.effort)) throw new Error("The selected reasoning effort is not offered by this model. Select its Harness default or a supported effort.")
    if (!manifest.capabilities.permissions.includes(args.permissionMode as "request" | "full")) throw new Error("Unsupported add-on permission mode.")
    const acquired = await this.acquire(provider)
    return addonTurn(provider, acquired.client, args, acquired.release)
  }
}
