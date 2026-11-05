/** Runs in the user's dsh via its documented --patch plugin extension. No vendor runtime is bundled. */
import { createInterface } from "node:readline"
import { createHash, randomUUID } from "node:crypto"
import { harnessConfigInputSchema, harnessModelId, type HarnessModel } from "../../../src/shared/harness-models"

export const name = "stillon-model-control"
export const inject = ["llm", "settings", "credentials", "sdkAppStartup"]
// These are public Cordis service contracts. Keeping the boundary structural avoids
// loading a second copy of the user's runtime and its branded service definitions.
interface Context {
  loader: { await(): Promise<void> }
  llm: {
    listProviders(): { id: string; name: string }[]
    listConfigurableProviders(): { provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean; defaultBaseURL?: string; nativeAuth?: { env: string[]; oauth: boolean } }[]
    listModels(provider: string): Promise<{ id: string; name: string }[]>
    resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow: number }; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }>
    discoverModels(ns: string, request: object): Promise<{ id: string }[]>
  }
  settings: {
    describe(options: { redactSecrets: true }): { ns: string; value: any; revision: number }[]
    mutate(ns: string, ops: { op: "set"; path: string[]; value: unknown }[], revision: number): Promise<void>
  }
  credentials: { describe(ref: string): Promise<{ configured: boolean; source?: string }>; set(ref: string, value: string): Promise<void>; unset(ref: string): Promise<void> }
  on(event: "dispose", callback: () => void): void
}
function directory(ctx: Context) {
  const descriptors = ctx.settings.describe({ redactSecrets: true })
  return ctx.llm.listConfigurableProviders().map(route => {
    const descriptor = descriptors.find(d => d.ns === route.settingsNs)
    const profile = route.settingsPath.reduce((v, k) => v?.[k], descriptor?.value) ?? {}
    const revision = createHash("sha256").update(JSON.stringify(profile)).digest("hex")
    return { ...route, descriptor, profile, revision }
  })
}
export function apply(ctx: Context) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  async function handle(method: string, params: any): Promise<unknown> {
    if (method === "shutdown") return { ok: true }
    await ctx.loader.await()
    const routes = directory(ctx), active = ctx.llm.listProviders()
    if (method === "configuration") {
      const services = await Promise.all(routes.map(async route => {
        const ref = route.profile.apiKeyEnv
        const info = typeof ref === "string" ? await ctx.credentials.describe(ref) : { configured: false }
        return { id: route.provider, label: route.displayName, active: active.some(p => p.id === route.provider),
          configurable: Boolean(route.descriptor), account: route.provider === "deepseek-account",
          baseURL: typeof route.profile.baseURL === "string" ? route.profile.baseURL : route.defaultBaseURL ?? "",
          api: typeof route.profile.api === "string" ? route.profile.api : "",
          apiKeyConfigured: info.configured, credentialSource: info.source,
          revision: route.revision, custom: route.declared === true }
      }))
      return { services, profile: "sdk" }
    }
    if (method === "discover") {
      const provider = params?.provider
      if (typeof provider !== "string" || !active.some(p => p.id === provider)) throw new Error("inactive")
      const models = await ctx.llm.listModels(provider)
      if (models.length > 1000) throw new Error("too many models")
      const output: HarnessModel[] = []
      for (const model of models) {
        const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
        output.push({ id: harnessModelId(provider, model.id), provider, model: model.id,
          label: `${model.name} · ${provider}`, supportsEffort: Boolean(resolved.reasoning?.efforts.length),
          efforts: resolved.reasoning?.efforts.map(e => ({ id: e.id, label: e.name })) ?? [],
          defaultEffort: resolved.reasoning?.defaultEffort, contextWindow: resolved.context?.contextWindow })
      }
      return output
    }
    if (method === "fetchModels") {
      const input = harnessConfigInputSchema.parse(params)
      const route = routes.find(r => r.provider === input.provider)
      const ns = route?.settingsNs ?? "llm-pi-ai"
      return await ctx.llm.discoverModels(ns, { provider: input.provider, baseURL: input.baseURL || undefined,
        api: input.api || undefined, apiKey: input.apiKey })
    }
    if (method === "configure") {
      const input = harnessConfigInputSchema.parse(params)
      const route = routes.find(r => r.provider === input.provider)
      if (input.provider === "deepseek-account") throw new Error("account login belongs to Harness")
      if (route ? route.revision !== input.revision : input.revision !== "") throw new Error("stale")
      const descriptor = route?.descriptor ?? ctx.settings.describe({ redactSecrets: true }).find(d => d.ns === "llm-pi-ai")
      if (!descriptor) throw new Error("settings unavailable")
      const prefix = route?.settingsPath ?? ["providers", input.provider]
      const ops: { op: "set"; path: string[]; value: unknown }[] = []
      const put = (field: string, value: unknown) => ops.push({ op: "set", path: [...prefix, field], value })
      if (input.baseURL) put("baseURL", input.baseURL)
      if (input.api) put("api", input.api)
      if (input.models) {
        // Preserve advanced metadata for model IDs that already exist.
        const old = route?.profile.models ?? []
        put("models", input.models.map(id => old.find((m: any) => m.id === id) ?? { id }))
      }
      if (!route && (!input.baseURL || !input.api || !input.models?.length)) throw new Error("custom provider needs endpoint, protocol and models")
      if (route && !active.some(p => p.id === input.provider) && ops.length === 0) ops.push({ op: "set", path: prefix, value: {} })
      // New keys get a fresh reference. A failed config write cannot rotate an
      // existing credential used by another profile or running application.
      const ref = input.apiKey ? `STILLON_DSH_${randomUUID().replaceAll("-", "").toUpperCase()}` : undefined
      if (ref) { await ctx.credentials.set(ref, input.apiKey!); put("apiKeyEnv", ref) }
      try { if (ops.length) await ctx.settings.mutate(descriptor.ns, ops, descriptor.revision) }
      catch (error) { if (ref) await ctx.credentials.unset(ref); throw error }
      return { ok: true }
    }
    throw new Error("Unsupported model operation")
  }
  lines.on("line", line => {
    queue = queue.then(async () => {
      let frame: any
      try {
        frame = JSON.parse(line)
        const result = await handle(frame.method, frame.params)
        process.stdout.write(JSON.stringify({ id: frame.id, result }) + "\n")
      } catch {
        // Vendor exceptions may contain request headers or echoed API keys.
        process.stdout.write(JSON.stringify({ id: frame?.id, error: { message: "Harness model operation failed. Reload the configuration; check the provider, endpoint, credentials and CLI version." } }) + "\n")
      }
    })
  })
  ctx.on("dispose", () => lines.close())
  process.stdout.write(JSON.stringify({ method: "stillon/ready" }) + "\n")
}
