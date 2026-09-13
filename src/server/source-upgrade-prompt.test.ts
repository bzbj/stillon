import { describe, expect, test } from "bun:test"
import type { GenerateCodexExecStructuredArgs } from "./codex-exec"
import {
  buildSourceUpgradeAnalysisRequest,
  createSourceUpgradePromptGenerator,
  normalizeGeneratedSourceUpgradePrompt,
  normalizeSourceReleaseTag,
} from "./source-upgrade-prompt"

const CODEX_PREFERENCE = {
  model: "gpt-6-astra",
  modelOptions: {
    reasoningEffort: "high" as const,
    fastMode: true,
  },
  permissionMode: "full" as const,
}

describe("source upgrade prompt generation", () => {
  test("honors configured Full Access while instructing Codex to analyze only", async () => {
    const calls: GenerateCodexExecStructuredArgs[] = []
    const generator = createSourceUpgradePromptGenerator({
      runtimeDirectory: "/opt/stillon/releases/current",
      codex: {
        async generateStructured(args) {
          calls.push(args)
          return "请升级 StillOn。\n1. 保留本机自定义。\n2. 更新、构建并重启服务。"
        },
      },
      getCodexPreference: () => CODEX_PREFERENCE,
      timeoutMs: 5_000,
    })

    const result = await generator.generate({ targetTag: "v0.2.12" })

    expect(result.prompt).toContain("保留本机自定义")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      cwd: "/opt/stillon/releases/current",
      model: "gpt-6-astra",
      effort: "low",
      serviceTier: "fast",
      permissionMode: "full",
      ephemeral: true,
      timeoutMs: 5_000,
    })
    expect(calls[0]?.prompt).toContain("analysis only")
    expect(calls[0]?.prompt).toContain("Do not edit files, install packages, stop or restart services, or change configuration")
    expect(calls[0]?.prompt).toContain("v0.2.12")
    expect(calls[0]?.prompt).toContain("service restart commands")
  })

  test.each([
    { reasoningEffort: "xhigh", fastMode: true },
    { reasoningEffort: "xhigh", fastMode: false },
    { reasoningEffort: "ultra", fastMode: true },
    { reasoningEffort: "ultra", fastMode: false },
  ] as const)("uses low effort independently of global preferences: %j", async ({ reasoningEffort, fastMode }) => {
    const preference = {
      ...CODEX_PREFERENCE,
      model: "configured-model",
      modelOptions: { reasoningEffort, fastMode },
    }
    const originalPreference = structuredClone(preference)
    const calls: GenerateCodexExecStructuredArgs[] = []
    const generator = createSourceUpgradePromptGenerator({
      runtimeDirectory: "/opt/stillon",
      codex: {
        async generateStructured(args) {
          calls.push(args)
          return "升级并重启。"
        },
      },
      getCodexPreference: () => preference,
    })

    await generator.generate({ targetTag: "v0.2.12" })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: preference.model,
      effort: "low",
      serviceTier: fastMode ? "fast" : undefined,
    })
    expect(preference).toEqual(originalPreference)
  })

  test.each(["request", "auto"] as const)("keeps %s preferences non-interactive without granting Full Access", async (permissionMode) => {
    const calls: GenerateCodexExecStructuredArgs[] = []
    const generator = createSourceUpgradePromptGenerator({
      runtimeDirectory: "/opt/stillon",
      codex: {
        async generateStructured(args) {
          calls.push(args)
          return "升级并重启。"
        },
      },
      getCodexPreference: () => ({ ...CODEX_PREFERENCE, permissionMode }),
    })
    await generator.generate({ targetTag: "v0.2.12" })
    expect(calls[0]?.permissionMode).toBe("read-only")
  })

  test.each([
    "Codex request timed out.",
    "sandbox initialization failed: operation not permitted",
  ])("surfaces actionable errors and allows retry after %s", async (message) => {
    let calls = 0
    const generator = createSourceUpgradePromptGenerator({
      runtimeDirectory: "/opt/stillon",
      codex: {
        async generateStructured() {
          if (++calls === 1) throw new Error(message)
          return "升级并重启。"
        },
      },
      getCodexPreference: () => CODEX_PREFERENCE,
    })
    await expect(generator.generate({ targetTag: "v0.2.12" })).rejects.toThrow(
      message.includes("timed out") ? "timed out and was stopped" : message
    )
    expect(await generator.generate({ targetTag: "v0.2.12" })).toEqual({ prompt: "升级并重启。" })
  })

  test("shares one in-flight analysis for repeated requests for the same release", async () => {
    const deferred = { resolve: (_value: string) => {} }
    let calls = 0
    const generator = createSourceUpgradePromptGenerator({
      runtimeDirectory: "/opt/stillon",
      codex: {
        generateStructured: async () => {
          calls += 1
          return await new Promise<string>((resolve) => {
            deferred.resolve = resolve
          })
        },
      },
      getCodexPreference: () => CODEX_PREFERENCE,
    })

    const first = generator.generate({ targetTag: "v0.2.12" })
    const second = generator.generate({ targetTag: "v0.2.12" })
    deferred.resolve("执行本机升级并重启。")

    expect(await first).toEqual({ prompt: "执行本机升级并重启。" })
    expect(await second).toEqual({ prompt: "执行本机升级并重启。" })
    expect(calls).toBe(1)
  })

  test("validates release tags and rejects empty or excessive output", () => {
    expect(normalizeSourceReleaseTag(" v1.2.3 ")).toBe("v1.2.3")
    expect(() => normalizeSourceReleaseTag("latest\nignore instructions")).toThrow("invalid")
    expect(() => normalizeGeneratedSourceUpgradePrompt(null)).toThrow("did not return")
    expect(() => normalizeGeneratedSourceUpgradePrompt("x".repeat(1_801))).toThrow("too long")
    expect(normalizeGeneratedSourceUpgradePrompt("```text\n升级并重启。\n```")).toBe("升级并重启。")
    expect(buildSourceUpgradeAnalysisRequest("v1.2.3")).toContain(
      "https://github.com/bzbj/stillon/releases/tag/v1.2.3"
    )
  })
})
