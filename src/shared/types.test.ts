import { describe, expect, test } from "bun:test"
import {
  deriveClaudeModelLabel,
  normalizeClaudeContextWindow,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  CODEX_MODELS,
  getCodexReasoningOptions,
  supportsCodexFastMode,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("derives fallback Claude model labels from model ids", () => {
    expect(deriveClaudeModelLabel("claude-fable-5")).toBe("Fable")
    expect(deriveClaudeModelLabel("claude-opus-4-8")).toBe("Opus")
    expect(deriveClaudeModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku")
  })

  test("normalizes Claude aliases via the provider catalog", () => {
    expect(normalizeClaudeModelId("fable")).toBe("claude-fable-5")
    expect(normalizeClaudeModelId("claude-fable-5")).toBe("claude-fable-5")
    expect(normalizeClaudeModelId("opus")).toBe("claude-opus-4-8")
    expect(normalizeClaudeModelId("sonnet")).toBe("claude-sonnet-4-6")
    expect(normalizeClaudeModelId("haiku")).toBe("claude-haiku-4-5-20251001")
  })

  test("normalizes legacy Codex aliases and defaults to the configured catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-6-sol")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-6-sol")
  })

  test("recognizes Astra and all of its reasoning efforts and Fast Mode", () => {
    expect(normalizeCodexModelId("gpt-6-astra")).toBe("gpt-6-astra")
    expect(getCodexReasoningOptions("gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"])
    expect(supportsCodexFastMode("gpt-6-astra")).toBe(true)
  })

  test("uses model-specific Codex effort and Fast Mode metadata", () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])
    expect(getCodexReasoningOptions("gpt-6-sol")).toContain("ultra")
    expect(getCodexReasoningOptions("gpt-6-luna")).toContain("ultra")
    expect(getCodexReasoningOptions("gpt-6-luna")).toContain("max")
    expect(supportsCodexFastMode("gpt-6-sol")).toBe(true)
    expect(supportsCodexFastMode("gpt-6-luna")).toBe(true)
    expect(normalizeCodexModelId("gpt-5.6-luna")).toBe("gpt-6-luna")
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-fable-5")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-8")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(false)
  })

  test("defaults Fable 5 to its 1M context window", () => {
    expect(normalizeClaudeContextWindow("claude-fable-5")).toBe("1m")
    expect(normalizeClaudeContextWindow("fable")).toBe("1m")
  })
})
