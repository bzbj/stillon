import { z } from "zod"
import policy from "./codex-model-policy.json"

const modelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  aliases: z.array(z.string().min(1)).optional(),
  supportsEffort: z.boolean(),
  supportedReasoningEfforts: z.array(z.enum(["low", "medium", "high", "xhigh", "max", "ultra"])).min(1),
  supportsFastMode: z.boolean(),
}).strict()

export const codexModelPolicySchema = z.object({
  models: z.array(modelSchema).min(1),
  roles: z.object({
    conversation: z.string().min(1),
    background: z.string().min(1),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const names = new Set<string>()
  for (const [index, model] of value.models.entries()) {
    for (const name of [model.id, ...(model.aliases ?? [])]) {
      if (names.has(name)) {
        ctx.addIssue({ code: "custom", path: ["models", index], message: `Duplicate model ID or alias: ${name}` })
      }
      names.add(name)
    }
  }
  const ids = new Set(value.models.map((model) => model.id))
  for (const [role, id] of Object.entries(value.roles)) {
    if (!ids.has(id)) {
      ctx.addIssue({ code: "custom", path: ["roles", role], message: `Role must reference a selectable model: ${id}` })
    }
  }
})

export const CODEX_MODEL_POLICY = codexModelPolicySchema.parse(policy)
