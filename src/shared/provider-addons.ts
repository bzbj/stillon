import { z } from "zod"
import type { ProviderCatalogEntry } from "./types"

export const ADDON_API = 1
export const MAX_ADDON_BYTES = 4 * 1024 * 1024
export const BUNDLED_INTEGRATIONS = { deepseek: "DeepSeek Harness", codebuddy: "CodeBuddy CLI (Preview)" } as const
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u)
const option = z.object({ id: z.string().min(1).max(128), label: z.string().min(1).max(128) })
export const addonManifestSchema = z.object({
  format: z.literal(1),
  // Provider IDs are persisted wire identities and cannot shadow built-ins.
  id: z.enum(["deepseek", "codebuddy"]), name: z.string().min(1).max(100), version,
  hostApi: z.number().int(),
  targets: z.array(z.string().regex(/^(win32|darwin|linux)-(x64|arm64)$/u)).min(1),
  testedCliVersions: z.array(version).min(1),
  catalog: z.object({
    id: z.enum(["deepseek", "codebuddy"]), label: z.string().min(1).max(100), defaultModel: z.string().min(1).max(128),
    defaultEffort: z.string().max(64).optional(),
    models: z.array(option.extend({ supportsEffort: z.boolean() })).min(1).max(100),
    efforts: z.array(option).max(20),
  }),
  capabilities: z.object({ resume: z.boolean(), fork: z.boolean(), images: z.boolean(), streaming: z.boolean(),
    questions: z.boolean(), permissions: z.array(z.enum(["request", "full"])).min(1), modelManagement: z.boolean().optional() }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(value => value.id === value.catalog.id, "Package and provider identity must match")
  .refine(value => value.catalog.models.some(model => model.id === value.catalog.defaultModel), "Default model must be declared")
export type AddonManifest = z.infer<typeof addonManifestSchema>
export type AddonPackage = { manifest: AddonManifest; code: string }
export type AddonSnapshot = {
  id: string; name: string; version: string; enabled: boolean; compatible: boolean; busy: boolean;
  previousVersion?: string; error?: string; bundled?: boolean
}
export type AddonList = { addons: AddonSnapshot[]; providers: ProviderCatalogEntry[]; canManage: boolean }
