# Refactor TODO

Tracking list for the refactors proposed on 2026-04-21.

Use `[x]` when an item is complete. Add any follow-up notes directly under the item when work starts.

## Pending

- [x] Retire product-owned tunnel lifecycle
  Scope: CLI, development launcher, dependencies, and external-ingress docs
  Goals:
  - Remove built-in quick/named Cloudflare tunnels and their dependencies.
  - Keep loopback as the default and preserve explicit direct listeners.
  - Document a generic trusted-proxy contract without provisioning the proxy.
  Expected impact: a smaller product-owned network surface while preserving
  operator-managed external access.

- [x] Sidebar project order persistence simplification
  Commit: `1167a18`
  Scope: `src/server/events.ts`, `src/server/event-store.ts`, `src/server/read-models.ts`, snapshot/compaction plumbing
  Goals:
  - Replace `sidebar_project_order_set` event-sourcing with a small dedicated preference file such as `sidebar-order.json`.
  - Remove sidebar order from replay, `StoreState`, and compaction snapshot handling.
  - Keep restart/load behavior aligned with other preference storage patterns such as keybindings and LLM provider config.
  Expected impact: less event plumbing and lower blast radius for preference corruption.
  Status: completed on 2026-04-21.

- [x] Model ID normalization consolidation
  Commit: `db77356`
  Scope: `src/shared/types.ts`, `src/client/stores/chatPreferencesStore.ts`, related server call sites
  Goals:
  - Derive Claude model normalization from the shared `PROVIDERS` catalog instead of a separate switch mapping.
  - Move Codex model normalization into shared code alongside Claude normalization.
  - Replace `isClaudeOpusModelId` string-prefix logic with declarative model metadata if practical.
  Expected impact: one source of truth for model normalization and capability checks.
  Status: completed on 2026-04-21.

- [ ] WS router command handler extraction
  Scope: `src/server/ws-router.ts`
  Goals:
  - Extract the repeated “resolve project, call diff store, ack, maybe broadcast” flow into a helper.
  - Collapse the repeated git-related command cases onto that helper.
  - Make broadcast semantics explicit and consistent (`return` vs `break`).
  Expected impact: smaller router, lower risk of inconsistent broadcast behavior.

- [ ] Shared profiling/logging helper extraction
  Scope: `src/server/event-store.ts`, `src/server/ws-router.ts`
  Goals:
  - Move duplicated send-to-starting profiling env-var checks and logging formatting into a shared profiling module.
  - Let call sites pass per-event details such as `traceId` and `startedAt`.
  Expected impact: one profiling format and one implementation path.

- [ ] Tool call type-system registry refactor
  Commits: `3f50f10`, `f997856`
  Scope: `src/shared/types.ts`, plus any affected rendering/type consumers
  Goals:
  - Replace the parallel tool-call type hierarchies with a registry/map-driven type definition.
  - Derive `ToolCallKind`, `NormalizedToolCall`, and `HydratedToolCall` from that registry.
  - Reduce the number of places touched when adding a new tool call kind.
  Expected impact: major type boilerplate reduction; moderate refactor risk.

- [ ] chatPreferencesStore normalization reduction
  Commit: `db77356`
  Scope: `src/client/stores/chatPreferencesStore.ts`
  Goals:
  - Replace broad always-on legacy normalization with a one-time migration toward the current schema.
  - Remove old persisted-state branches once migration guarantees the current shape.
  - Consolidate provider preference normalization paths where possible.
  Expected impact: substantially smaller store logic with clearer current-state handling.
