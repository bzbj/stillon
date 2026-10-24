import { create } from "zustand"
import { claudeModelPolicySchema, type ClaudeModelPolicySnapshot } from "../../shared/claude-model-policy"
import { applyClaudeModelPolicy } from "../../shared/types"
import { normalizeClaudePreference, useChatPreferencesStore } from "./chatPreferencesStore"

export const useClaudeModelPolicyStore = create<{ snapshot: ClaudeModelPolicySnapshot | null }>()(() => ({ snapshot: null }))

export function receiveClaudeModelPolicy(snapshot: ClaudeModelPolicySnapshot) {
  const policy = claudeModelPolicySchema.parse(snapshot.policy)
  const previous = useClaudeModelPolicyStore.getState().snapshot
  if (JSON.stringify(previous?.policy) !== JSON.stringify(policy)) {
    applyClaudeModelPolicy(policy)
    useChatPreferencesStore.setState((state) => ({
      providerDefaults: { ...state.providerDefaults, claude: normalizeClaudePreference(state.providerDefaults.claude) },
      chatStates: Object.fromEntries(Object.entries(state.chatStates).map(([id, composer]) => [
        id, composer.provider === "claude" ? { ...composer, ...normalizeClaudePreference(composer) } : composer,
      ])),
      legacyComposerState: state.legacyComposerState?.provider === "claude"
        ? { ...state.legacyComposerState, ...normalizeClaudePreference(state.legacyComposerState) }
        : state.legacyComposerState,
    }))
  }
  useClaudeModelPolicyStore.setState({ snapshot: { ...snapshot, policy } })
}
