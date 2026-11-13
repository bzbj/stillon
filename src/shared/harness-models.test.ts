import { expect, test } from "bun:test"
import { harnessModelLabel, harnessModelRoute, harnessPolicySchema } from "./harness-models"

test("saved legacy labels become short names without changing either provider route", () => {
  const models = ["deepseek-official", "gateway"].map(provider => ({
    id: provider === "deepseek-official" ? "deepseek-flash" : "dsh:gateway:deepseek-flash",
    provider, model: "deepseek-flash", label: `DeepSeek-V4.1-Flash · ${provider}`,
    supportsEffort: false, efforts: [],
  }))
  const policy = harnessPolicySchema.parse({ schema: 1, models, defaultModel: models[1]!.id })
  expect(policy.models.map(m => m.label)).toEqual(["DeepSeek Flash", "DeepSeek Flash"])
  expect(policy.models.map(m => ({ id: m.id, provider: m.provider, model: m.model })))
    .toEqual(models.map(m => ({ id: m.id, provider: m.provider, model: m.model })))
  expect(harnessModelRoute(policy.defaultModel)).toEqual({ provider: "gateway", model: "deepseek-flash" })
  expect(harnessPolicySchema.parse(policy)).toEqual(policy)
})

test("custom names and other provider text survive label normalization", () => {
  expect(harnessModelLabel("My model", "gateway", "custom-id")).toBe("My model")
  expect(harnessModelLabel("Model · other", "gateway", "custom-id")).toBe("Model · other")
  expect(harnessModelLabel("My model · gateway", "gateway", "custom-id")).toBe("My model")
  expect(harnessModelLabel("DeepSeek-V4-Pro", "deepseek-official", "deepseek-v4-pro")).toBe("DeepSeek V4 Pro")
})
