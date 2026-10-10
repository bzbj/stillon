import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BUNDLED_CODEX_MODEL_POLICY, type CodexModelPolicy } from "../shared/codex-model-policy"
import { getCodexModelForRole, normalizeCodexPreference } from "../shared/types"
import { applyServerCodexModelPolicy, getServerProviderCatalog, normalizeServerModel } from "./provider-catalog"
import { CodexModelPolicyManager } from "./codex-model-policy-manager"

function replacementPolicy(id = "future-codex"): CodexModelPolicy {
  return { models: [{ id, label: "Future Codex", aliases: ["gpt-6.1-sol", "gpt-6-sol"],
    supportsEffort: true, supportedReasoningEfforts: ["low", "high"], supportsFastMode: false }],
    roles: { conversation: id, background: id } }
}

let directory: string
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "stillon-model-policy-")) })
afterEach(async () => {
  applyServerCodexModelPolicy(BUNDLED_CODEX_MODEL_POLICY)
  await rm(directory, { recursive: true, force: true })
})
async function configure(manager: CodexModelPolicyManager, policy: CodexModelPolicy) {
  await writeFile(manager.filePath, JSON.stringify({ schemaVersion: 1, policy }))
}

describe("runtime Codex model configuration", () => {
  test("refresh synchronizes roles, aliases and capabilities, and rejects invalid configuration atomically", async () => {
    const manager = new CodexModelPolicyManager(directory)
    await manager.initialize()
    expect(JSON.parse(await readFile(manager.filePath, "utf8")).schemaVersion).toBe(1)
    await configure(manager, replacementPolicy())
    const accepted = await manager.refresh()
    expect(getCodexModelForRole("background")).toBe("future-codex")
    expect(getServerProviderCatalog("codex").models.map((model) => model.id)).toEqual(["future-codex"])
    expect(normalizeServerModel("codex", "gpt-6.1-sol")).toBe("future-codex")
    expect(normalizeCodexPreference({ model: "gpt-6.1-sol", modelOptions: { reasoningEffort: "ultra", fastMode: true } }))
      .toMatchObject({ model: "future-codex", modelOptions: { reasoningEffort: "low", fastMode: false } })
    for (const invalid of ["{", JSON.stringify({ schemaVersion: 2, policy: replacementPolicy() }),
      JSON.stringify({ schemaVersion: 1, policy: { ...replacementPolicy(), roles: { conversation: "missing", background: "future-codex" } } })]) {
      await writeFile(manager.filePath, invalid)
      await expect(manager.refresh()).rejects.toThrow("keeping the active policy")
      expect(manager.getSnapshot().revision).toBe(accepted.revision)
      expect(normalizeServerModel("codex")).toBe("future-codex")
    }
    const journal = JSON.parse(await readFile(path.join(directory, "codex-model-policy-state.json"), "utf8"))
    expect(journal.current).toEqual(replacementPolicy())
  })

  test("restart with broken or missing override keeps last-good; restore survives another restart", async () => {
    const first = new CodexModelPolicyManager(directory)
    await first.initialize()
    await configure(first, replacementPolicy())
    await first.refresh()
    await writeFile(first.filePath, "broken")
    const restarted = new CodexModelPolicyManager(directory)
    await restarted.initialize()
    expect(restarted.getSnapshot()).toMatchObject({ source: "last-good", policy: replacementPolicy() })
    expect(restarted.getSnapshot().warning).toContain("rejected")
    await restarted.restore("previous")
    expect(restarted.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
    const again = new CodexModelPolicyManager(directory)
    await again.initialize()
    expect(again.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
    await again.restore("previous")
    expect(again.getSnapshot().policy).toEqual(replacementPolicy())
    await rm(again.filePath)
    const missing = new CodexModelPolicyManager(directory)
    await missing.initialize()
    expect(missing.getSnapshot().policy).toEqual(replacementPolicy())
    await missing.restore("builtin")
    expect(missing.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
  })

  test("journal write failure cannot publish a candidate and subsequent refresh can recover", async () => {
    const manager = new CodexModelPolicyManager(directory)
    await manager.initialize()
    await configure(manager, replacementPolicy())
    const journalPath = path.join(directory, "codex-model-policy-state.json")
    await mkdir(journalPath)
    await expect(manager.refresh()).rejects.toThrow()
    expect(manager.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
    expect(normalizeServerModel("codex")).toBe("gpt-6.1-sol")
    const fileBeforeRestore = await readFile(manager.filePath, "utf8")
    await expect(manager.restore("builtin")).rejects.toThrow()
    expect(await readFile(manager.filePath, "utf8")).toBe(fileBeforeRestore)
    await rm(journalPath, { recursive: true })
    await manager.refresh()
    expect(manager.getSnapshot().policy).toEqual(replacementPolicy())
  })

  test("serialized refresh and restore leave a durable, matching configuration", async () => {
    const manager = new CodexModelPolicyManager(directory)
    await manager.initialize()
    await configure(manager, replacementPolicy())
    await Promise.all([manager.refresh(), manager.restore("builtin")])
    expect(manager.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
    expect(JSON.parse(await readFile(manager.filePath, "utf8")).policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
  })
})
