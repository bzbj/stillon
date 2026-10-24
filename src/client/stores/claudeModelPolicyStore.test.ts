import { afterEach, expect, test } from "bun:test"
import { BUNDLED_CLAUDE_MODEL_POLICY, applyClaudeModelPolicy, normalizeClaudeModelId } from "../../shared/types"
import { receiveClaudeModelPolicy, useClaudeModelPolicyStore } from "./claudeModelPolicyStore"
import { useChatPreferencesStore } from "./chatPreferencesStore"

afterEach(() => { applyClaudeModelPolicy(BUNDLED_CLAUDE_MODEL_POLICY); useClaudeModelPolicyStore.setState({ snapshot: null }) })
test("new catalog is installed before normalizing saved defaults and composers", () => {
  const preference = { model: "claude-next", modelOptions: { reasoningEffort: "high" as const, contextWindow: "200k" as const }, permissionMode: "acceptEdits" as const }
  useChatPreferencesStore.setState((state) => ({ providerDefaults: { ...state.providerDefaults, claude: preference }, chatStates: { sample: { provider: "claude", ...preference } } }))
  receiveClaudeModelPolicy({ revision: "new", warning: null, policy: { models: [{ id: "claude-next", label: "Next", supportsEffort: true }], defaultModel: "claude-next" } })
  expect(normalizeClaudeModelId("claude-next")).toBe("claude-next")
  expect(useChatPreferencesStore.getState().providerDefaults.claude.model).toBe("claude-next")
  expect(useChatPreferencesStore.getState().chatStates.sample?.model).toBe("claude-next")
})
