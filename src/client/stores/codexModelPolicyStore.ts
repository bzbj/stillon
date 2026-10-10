import { create } from "zustand"
import { codexModelPolicyFileSchema, type CodexModelPolicySnapshot } from "../../shared/codex-model-policy"
import { applyCodexModelPolicy, normalizeCodexPreference } from "../../shared/types"
import { useChatPreferencesStore } from "./chatPreferencesStore"

export const useCodexModelPolicyStore = create<{ snapshot: CodexModelPolicySnapshot | null }>()(() => ({ snapshot: null }))

/** Install before applying settings/chat messages, including the first reconnect
 * message. Never normalize a server model against a stale bundled catalog. */
export function receiveCodexModelPolicy(snapshot: CodexModelPolicySnapshot) {
  const policy = codexModelPolicyFileSchema.parse({ schemaVersion: snapshot.schemaVersion, policy: snapshot.policy }).policy
  const previous = useCodexModelPolicyStore.getState().snapshot
  if (JSON.stringify(previous?.policy) !== JSON.stringify(policy)) {
    applyCodexModelPolicy(policy)
    useChatPreferencesStore.setState((state) => ({
      providerDefaults: {
        ...state.providerDefaults,
        codex: normalizeCodexPreference(state.providerDefaults.codex),
      },
      chatStates: Object.fromEntries(Object.entries(state.chatStates).map(([id, composer]) => [
        id, composer.provider === "codex" ? { ...composer, ...normalizeCodexPreference(composer) } : composer,
      ])),
      legacyComposerState: state.legacyComposerState?.provider === "codex"
        ? { ...state.legacyComposerState, ...normalizeCodexPreference(state.legacyComposerState) }
        : state.legacyComposerState,
    }))
  }
  useCodexModelPolicyStore.setState({ snapshot: { ...snapshot, policy } })
}
