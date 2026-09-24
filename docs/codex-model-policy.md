# Codex model policy

Codex model upgrades are configured in `CODEX_MODEL_POLICY` in `src/shared/types.ts`.
The `models` list defines the selectable IDs, labels, legacy aliases, supported reasoning efforts, and Fast Mode support. The `roles` map selects the default model for a new conversation and the lightweight background model used for title generation. Every role must point to an ID in `models`.

When changing the catalog, update this policy and its focused tests in `src/shared/types.test.ts`. Add aliases for previously saved IDs that should migrate to a current model. Client preferences and server settings both use the shared Codex normalizer, so an old ID resolves the same way in either store. Unknown IDs resolve to the conversation default. Historical transcript entries are not rewritten.

Run `bun run check` and `bun run test` before merging. A model policy change does not itself release a package or upgrade a running service. The separate OpenAI API provider model is configured outside this Codex policy.
