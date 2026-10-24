import { z } from "zod"

export const claudeModelIdSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/, "Use a model ID without spaces or shell characters")
export const claudeModelSchema = z.object({
  id: claudeModelIdSchema,
  label: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  aliases: z.array(claudeModelIdSchema).max(30).optional(),
  supportsEffort: z.boolean(),
  supportsMaxReasoningEffort: z.boolean().optional(),
  contextWindowOptions: z.array(z.object({ id: z.enum(["200k", "1m"]), label: z.string().min(1).max(30) })).max(2).optional(),
})
export const claudeModelPolicySchema = z.object({
  models: z.array(claudeModelSchema).min(1).max(100),
  defaultModel: claudeModelIdSchema,
}).superRefine((policy, ctx) => {
  const ids = new Set<string>()
  for (const model of policy.models) {
    for (const id of [model.id, ...(model.aliases ?? [])]) {
      if (ids.has(id)) ctx.addIssue({ code: "custom", message: `Duplicate model ID or alias: ${id}` })
      ids.add(id)
    }
  }
  if (!policy.models.some((model) => model.id === policy.defaultModel)) {
    ctx.addIssue({ code: "custom", message: "Choose an enabled default model" })
  }
})
export type ClaudeModelPolicy = z.infer<typeof claudeModelPolicySchema>
export interface ClaudeModelPolicySnapshot { revision: string; policy: ClaudeModelPolicy; warning: string | null }
export interface ClaudeModelDraft { models: ClaudeModelPolicy["models"]; baseRevision: string }
export const claudeModelSelectionSchema = z.object({ baseRevision: z.string(), policy: claudeModelPolicySchema })
export type ClaudeModelSelection = z.infer<typeof claudeModelSelectionSchema>
