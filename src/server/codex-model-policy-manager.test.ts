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

const discovered = () => ({ cliVersion: "0.159.2", models: [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "Previous Sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  { id: "future", model: "future", displayName: "Future", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "new-effort" }] },
  { id: "incompatible", model: "incompatible", displayName: "Incompatible", supportedReasoningEfforts: [{ reasoningEffort: "new-effort" }] },
  { id: "no-effort", model: "no-effort", displayName: "No effort", supportedReasoningEfforts: [] },
] })

test("discovery is a read-only draft; explicit selection persists capabilities, aliases, roles and rollback", async () => {
  const manager = new CodexModelPolicyManager(directory, { discover: async () => discovered(), getContext: async () => "account-a" })
  await manager.initialize()
  const before = manager.getSnapshot()
  const beforeFile = await readFile(manager.filePath, "utf8")
  const draft = await manager.discover()
  expect(manager.getSnapshot()).toEqual(before)
  expect(await readFile(manager.filePath, "utf8")).toBe(beforeFile)
  expect(draft.selectedModelIds).toEqual(before.policy.models.map((model) => model.id))
  expect(draft.candidates.find((candidate) => candidate.model.id === "gpt-6-luna")?.available).toBe(false)
  expect(draft.candidates.find((candidate) => candidate.model.id === "incompatible")?.disabledReason).toBeDefined()
  expect(draft.candidates.find((candidate) => candidate.model.id === "future")?.model.supportsFastMode).toBe(false)
  expect(draft.candidates.find((candidate) => candidate.model.id === "no-effort")?.disabledReason).toBeDefined()
  expect(draft.warnings.length).toBe(2)
  const selection = { draftId: draft.id, modelIds: ["gpt-6.1-sol", "gpt-6-sol", "future"], roles: { conversation: "gpt-6.1-sol", background: "future" } }
  const accepted = await manager.applySelection(selection)
  expect(accepted.policy.models.map((model) => model.id)).toEqual(selection.modelIds)
  expect(accepted.policy.models[0]?.aliases).not.toContain("gpt-6-sol")
  expect(accepted.policy.models[0]?.aliases).toContain("gpt-5.6-sol")
  expect(accepted.policy.models[0]?.supportsFastMode).toBe(true)
  expect(accepted.policy.models[2]?.supportedReasoningEfforts).toEqual(["high"])
  expect(accepted.policy.roles).toEqual(selection.roles)
  const restarted = new CodexModelPolicyManager(directory)
  await restarted.initialize()
  expect(restarted.getSnapshot().policy).toEqual(accepted.policy)
  await restarted.restore("previous")
  expect(restarted.getSnapshot().policy).toEqual(before.policy)
  await expect(manager.applySelection(selection)).rejects.toThrow("expired")
})

test("confirmation rejects tampered, incompatible, stale and account-changed drafts without replacing files", async () => {
  let context = "account-a"
  const manager = new CodexModelPolicyManager(directory, { discover: async () => discovered(), getContext: async () => context })
  await manager.initialize()
  const draft = await manager.discover()
  const beforeFile = await readFile(manager.filePath, "utf8")
  const selection = { draftId: draft.id, modelIds: ["future"], roles: { conversation: "future", background: "future" } }
  for (const modelIds of [[], ["future", "future"], ["invented"], ["incompatible"]]) {
    await expect(manager.applySelection({ ...selection, modelIds })).rejects.toThrow()
    expect(await readFile(manager.filePath, "utf8")).toBe(beforeFile)
  }
  await expect(manager.applySelection({ ...selection, roles: { conversation: "missing", background: "future" } })).rejects.toThrow()
  context = "account-b"
  await expect(manager.applySelection(selection)).rejects.toThrow("account or CLI changed")
  context = "account-a"
  await configure(manager, replacementPolicy())
  await manager.refresh()
  await expect(manager.applySelection(selection)).rejects.toThrow("configuration changed")
  expect(manager.getSnapshot().policy).toEqual(replacementPolicy())
})

test("failed discovery retains policy; concurrent discovery shares one bounded request and shutdown awaits it", async () => {
  let calls = 0
  let finish!: (value: ReturnType<typeof discovered>) => void
  const manager = new CodexModelPolicyManager(directory, { getContext: async () => "same", discover: () => {
    calls++
    return new Promise((resolve) => { finish = resolve })
  } })
  await manager.initialize()
  const a = manager.discover(), b = manager.discover()
  await Bun.sleep(0)
  expect(calls).toBe(1)
  expect(manager.busy).toBe(true)
  const close = manager.close()
  finish(discovered())
  const [first, second] = await Promise.all([a, b])
  expect(first.id).toBe(second.id)
  await close
  expect(manager.busy).toBe(false)
  await expect(manager.discover()).rejects.toThrow("shutting down")
  const failing = new CodexModelPolicyManager(directory, { getContext: async () => "same", discover: async () => { throw new Error("offline") } })
  await failing.initialize()
  const initial = failing.getSnapshot()
  await expect(failing.discover()).rejects.toThrow("offline")
  expect(failing.getSnapshot()).toEqual(initial)
})

test("confirmation journal failure restores editable file and preserves the draft for retry", async () => {
  const manager = new CodexModelPolicyManager(directory, { discover: async () => discovered(), getContext: async () => "same" })
  await manager.initialize()
  const before = await readFile(manager.filePath, "utf8")
  const draft = await manager.discover()
  const selection = { draftId: draft.id, modelIds: ["future"], roles: { conversation: "future", background: "future" } }
  const journal = path.join(directory, "codex-model-policy-state.json")
  await mkdir(journal)
  await expect(manager.applySelection(selection)).rejects.toThrow()
  expect(await readFile(manager.filePath, "utf8")).toBe(before)
  expect(manager.getSnapshot().policy).toEqual(BUNDLED_CODEX_MODEL_POLICY)
  await rm(journal, { recursive: true })
  await manager.applySelection(selection)
  expect(manager.getSnapshot().policy.models.map((model) => model.id)).toEqual(["future"])
})

test("expired confirmation and context changes during discovery preserve active configuration", async () => {
  let now = Date.now()
  const manager = new CodexModelPolicyManager(directory, { now: () => now,
    discover: async () => discovered(), getContext: async () => "account" })
  await manager.initialize()
  const draft = await manager.discover()
  const before = await readFile(manager.filePath, "utf8")
  now += 31 * 60_000
  await expect(manager.applySelection({ draftId: draft.id, modelIds: ["future"],
    roles: { conversation: "future", background: "future" } })).rejects.toThrow("expired")
  expect(await readFile(manager.filePath, "utf8")).toBe(before)
  let reads = 0
  const changing = new CodexModelPolicyManager(directory, {
    discover: async () => discovered(), getContext: async () => ++reads === 1 ? "before" : "after" })
  await changing.initialize()
  const initial = changing.getSnapshot()
  await expect(changing.discover()).rejects.toThrow("changed during discovery")
  expect(changing.getSnapshot()).toEqual(initial)
})
