import { z } from "zod"

const text = z.string().min(1).max(256)
/** Display names are independent of the provider/model pair used for routing. */
export function harnessModelLabel(label: string, provider: string, model: string) {
  const suffix = ` · ${provider}`
  const name = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label
  if (model === "deepseek-flash" && [model, "DeepSeek-V4.1-Flash", "DeepSeek Flash"].includes(name)) return "DeepSeek Flash"
  if (model === "deepseek-v4-pro" && [model, "DeepSeek-V4-Pro", "DeepSeek V4 Pro"].includes(name)) return "DeepSeek V4 Pro"
  return name || model
}
export const harnessModelSchema = z.object({
  id: z.string().min(1).max(1024), label: text, provider: text, model: text,
  supportsEffort: z.boolean(), efforts: z.array(z.object({ id: text, label: text })).max(30),
  defaultEffort: text.optional(), contextWindow: z.number().int().positive().optional(),
}).transform(model => ({ ...model, label: harnessModelLabel(model.label, model.provider, model.model) }))
export type HarnessModel = z.infer<typeof harnessModelSchema>
export const harnessPolicySchema = z.object({ schema: z.literal(1), models: z.array(harnessModelSchema).min(1).max(1000), defaultModel: z.string().min(1).max(1024) })
  .refine(p => new Set(p.models.map(m => m.id)).size === p.models.length && p.models.some(m => m.id === p.defaultModel), "Select a default from the enabled models.")
export type HarnessModelPolicy = z.infer<typeof harnessPolicySchema>
export interface HarnessService {
  id: string; label: string; active: boolean; configurable: boolean; account: boolean;
  baseURL: string; api: string; apiKeyConfigured: boolean; credentialSource?: string;
  revision: string; custom: boolean
}
export interface HarnessConfiguration { services: HarnessService[]; profile: string }
export const harnessConfigInputSchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  revision: z.string().max(128),
  baseURL: z.string().max(2048).refine(value => {
    if (!value) return true
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash } catch { return false }
  }, "Use an HTTP(S) base URL without credentials or query parameters."),
  api: z.enum(["", "openai-completions", "openai-responses", "anthropic-messages"]),
  apiKey: z.string().min(1).max(8192).optional(),
  // Omission preserves the native model catalog and all its advanced fields.
  models: z.array(text).min(1).max(1000).optional(),
}).strict()
export type HarnessConfigInput = z.infer<typeof harnessConfigInputSchema>
export const harnessDiscoverySchema = z.object({ provider: text }).strict()
export const harnessSelectionSchema = z.object({ ids: z.array(z.string().min(1).max(1024)).min(1).max(1000), defaultModel: z.string().min(1).max(1024) }).strict()

/** Keep the two original routes compatible with existing chat preferences. */
export function harnessModelId(provider: string, model: string) {
  return provider === "deepseek-official" && ["deepseek-flash", "deepseek-v4-pro"].includes(model)
    ? model : `dsh:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}
export function harnessModelRoute(id: string) {
  if (!id.startsWith("dsh:")) return { provider: "deepseek-official", model: id }
  const parts = id.split(":")
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw new Error("Invalid Harness model route.")
  return { provider: decodeURIComponent(parts[1]), model: decodeURIComponent(parts[2]) }
}
