import { describe, expect, test } from "bun:test"
import policy from "./codex-model-policy.json"
import { codexModelPolicySchema } from "./codex-model-policy"

describe("Codex model policy configuration", () => {
  test("rejects colliding IDs and aliases", () => {
    const value = structuredClone(policy)
    value.models[1]!.aliases = [value.models[0]!.id]
    expect(() => codexModelPolicySchema.parse(value)).toThrow("Duplicate model ID or alias")
    value.models[1]!.aliases = []
    value.models[1]!.id = value.models[0]!.id
    expect(() => codexModelPolicySchema.parse(value)).toThrow("Duplicate model ID or alias")
  })

  test("rejects roles referencing aliases or absent models", () => {
    for (const id of ["gpt-6-sol", "missing-model"]) {
      const value = structuredClone(policy)
      value.roles.conversation = id
      expect(() => codexModelPolicySchema.parse(value)).toThrow("Role must reference a selectable model")
    }
  })

  test("rejects invalid capabilities", () => {
    const model = { ...policy.models[1], supportedReasoningEfforts: ["unsupported"] }
    expect(codexModelPolicySchema.safeParse({ ...policy, models: [model] }).success).toBe(false)
    expect(codexModelPolicySchema.safeParse({ ...policy, models: [{ ...model, supportsFastMode: "true" }] }).success).toBe(false)
  })
})
