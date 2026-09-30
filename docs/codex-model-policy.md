# Codex model policy

Codex model upgrades are configured in `src/shared/codex-model-policy.json`, validated by `src/shared/codex-model-policy.ts`, and exposed as `CODEX_MODEL_POLICY` through `src/shared/types.ts`.
The `models` list defines the selectable IDs, labels, legacy aliases, supported reasoning efforts, and Fast Mode support. The `roles` map selects the default model for a new conversation and the lightweight background model used for title generation. Every role must point to an ID in `models`.

When changing the catalog, edit the JSON policy. Schema validation rejects invalid capabilities, duplicate IDs or aliases, and roles that reference aliases or absent models. Shared behavior tests cover validation and migration. Update model-specific assertions in `src/shared/types.test.ts` when changing supported capabilities or the selectable catalog. Add aliases for previously saved IDs that should migrate to a current model. Client preferences and server settings both use the shared Codex normalizer, so an old ID resolves the same way in either store. Unknown IDs resolve to the conversation default. Historical transcript entries are not rewritten.

Version 0.4.5 replaces Sol 6 with Sol 6.1 (`gpt-6.1-sol`). Sol 6 and the older Sol/Terra aliases resolve to Sol 6.1. Its low, medium, high, xhigh, max, ultra reasoning levels and Fast tier were checked against the local Codex model catalog on 2026-10-01. Codex advertises low as its model default; StillOn retains its explicit xhigh application preference, and saved valid reasoning preferences are preserved.

The JSON policy is bundled into the client and loaded by the server from the same source. This simplifies catalog maintenance but still requires a release for installed clients. Runtime overrides and refresh without rebuilding require a server-owned catalog endpoint, client synchronization, and a last-known-good configuration; see [issue #164](https://github.com/bzbj/stillon/issues/164).

Run `bun run check` and `bun run test` before merging. A model policy change does not itself release a package or upgrade a running service. The separate OpenAI API provider model is configured outside this Codex policy.
