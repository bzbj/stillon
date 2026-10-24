import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaudeModelPolicyManager } from "./claude-model-policy-manager"
import { BUNDLED_CLAUDE_MODEL_POLICY, normalizeClaudeModelId } from "../shared/types"
import { applyServerClaudeModelPolicy, normalizeServerModel } from "./provider-catalog"

const roots: string[] = []
afterEach(async () => { applyServerClaudeModelPolicy(BUNDLED_CLAUDE_MODEL_POLICY); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function manager(discover?: () => Promise<any[]>) {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-claude-policy-")); roots.push(root)
  const manager = new ClaudeModelPolicyManager(root, { discover }); await manager.initialize()
  return { manager, root }
}

test("discovery resolves new canonical models without replacing an older family member, and changes nothing before apply", async () => {
  const { manager: m, root } = await manager(async () => [
    { value: "sonnet", resolvedModel: "claude-sonnet-next", displayName: "Sonnet Next", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "claude-sonnet-next", displayName: "Sonnet Next", supportsEffort: true },
  ])
  const before = m.getSnapshot(), draft = await m.discover()
  expect(m.getSnapshot()).toEqual(before)
  expect(draft.models.some((model) => model.id === "claude-sonnet-4-6")).toBe(true)
  expect(draft.models.filter((model) => model.id === "claude-sonnet-next")).toHaveLength(1)
  const policy = { models: draft.models.filter((model) => model.id === "claude-sonnet-next"), defaultModel: "claude-sonnet-next" }
  await m.apply({ baseRevision: before.revision, policy })
  expect(normalizeClaudeModelId("claude-sonnet-next")).toBe("claude-sonnet-next")
  expect(normalizeServerModel("claude", "claude-sonnet-next")).toBe("claude-sonnet-next")
  expect(normalizeClaudeModelId("removed-model")).toBe("claude-sonnet-next")
  const restarted = new ClaudeModelPolicyManager(root); await restarted.initialize()
  expect(restarted.getSnapshot().policy).toEqual(policy)
})

test("manual IDs, stale concurrent saves, malformed policies and discovery failure preserve accepted state", async () => {
  const { manager: m } = await manager(async () => { throw new Error("CLI unavailable") })
  const before = m.getSnapshot()
  const selection = { baseRevision: before.revision, policy: { models: [{ id: "custom/model-v2", label: "Custom", supportsEffort: false }], defaultModel: "custom/model-v2" } }
  const saved = await m.apply(selection)
  await expect(m.discover()).rejects.toThrow("CLI unavailable")
  await expect(m.apply(selection)).rejects.toThrow("changed on another device")
  for (const policy of [
    { models: [], defaultModel: "missing" },
    { models: [{ id: "bad id", label: "Bad", supportsEffort: false }], defaultModel: "bad id" },
    { models: [...saved.policy.models, ...saved.policy.models], defaultModel: "custom/model-v2" },
  ]) await expect(m.apply({ baseRevision: saved.revision, policy })).rejects.toThrow()
  expect(m.getSnapshot()).toEqual(saved)
})

test("concurrent refreshes share one metadata request", async () => {
  let calls = 0
  const { manager: m } = await manager(async () => { calls++; await Bun.sleep(20); return [{ value: "new-model" }] })
  await Promise.all([m.discover(), m.discover()])
  expect(calls).toBe(1)
})
