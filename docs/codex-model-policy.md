# Runtime Codex model configuration

StillOn reads its selectable Codex models, capabilities, aliases and default
roles from `<data directory>/codex-model-policy.json` (normally
`~/.stillon/data/codex-model-policy.json`). It creates this editable file on first
startup. The file lives outside the installed runtime and survives application
updates. Model catalog changes no longer require a frontend rebuild or an
application release.

Open **Settings → Providers → Codex Model Configuration → Fetch models from
Codex** after updating Codex CLI. This starts an isolated `codex app-server`
metadata connection and fetches all visible models through `model/list`. It
never starts a thread or turn and does not modify the active configuration.
There is no automatic startup or per-turn model discovery.

Review the candidate list, check the models you want to enable, and select the
conversation/background defaults from those models. Newly discovered models
are unchecked. Existing enabled models remain selected; those absent from the
returned catalog are marked as unverified and retained until you deselect them.
Unsupported models cannot be enabled. Click **Confirm and apply** to persist
only your selection, or **Cancel** to keep the current configuration.

Confirmation uses a server-owned draft, expires after 30 minutes, and rejects
changes to the active policy or Codex account/CLI/configuration since discovery.
Concurrent refresh requests share one metadata query. Discovery has a bounded
20-second timeout and response/page limits; failure preserves the current policy.
Candidates are temporary; confirmed models remain in the external configuration
and recovery journal across application restarts and upgrades. Codex's returned
catalog depends on the installed CLI, account and global provider configuration;
it is not a guarantee of global newest models or continuing remote availability.

Reasoning options come from discovery; unsupported options are omitted with a
warning, and models with no compatible options are disabled. Fast capability is
not inferred from `model/list`: existing local Fast configuration is preserved,
and new models default to Standard. Existing aliases are preserved unless they
conflict with a selected canonical ID. Official `isDefault`/`upgrade` hints do not
silently replace local defaults or selections. Saved valid preferences take
priority over role defaults. Active turn parameters and historical transcripts
are never rewritten; subsequent turns use the accepted policy. Connected clients
receive the authoritative policy before settings or chat preference normalization,
including reconnects. Restore previous/bundled configuration remains available.

For manual overrides, edit the local JSON and use **Advanced: local configuration
→ Reload local file**. CLI model additions using existing supported capabilities
need no StillOn reinstall or frontend rebuild. Protocol or new UI capabilities
may still require a StillOn application update.

The local file wraps the same validated policy used by the bundled catalog:

```json
{
  "schemaVersion": 1,
  "policy": {
    "models": [
      {
        "id": "gpt-6.1-sol",
        "label": "GPT-6.1-Sol",
        "description": "Coding and everyday work",
        "aliases": ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"],
        "supportsEffort": true,
        "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "supportsFastMode": true
      },
      {
        "id": "gpt-6-luna",
        "label": "GPT-6-Luna",
        "supportsEffort": true,
        "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "supportsFastMode": true
      }
    ],
    "roles": {
      "conversation": "gpt-6.1-sol",
      "background": "gpt-6-luna"
    }
  }
}
```

Use actual model IDs and capabilities supported by the installed Codex CLI and
account. The example demonstrates the schema; it is not an exhaustive model
list. `models` controls display order. Both roles must reference selectable IDs,
not aliases. IDs and aliases must be unique. Keep aliases for replaced IDs if
saved preferences should migrate. Valid saved Settings defaults take precedence
over the conversation role; the role supplies fresh/fallback defaults. The
background role is used for quick responses such as title generation. The
separate OpenAI API provider configuration is unchanged.

## Read, refresh and restore

On a loopback installation without password authentication:

```bash
curl --fail http://127.0.0.1:3210/api/codex/model-policy
curl --fail -X POST http://127.0.0.1:3210/api/codex/model-policy/refresh
curl --fail -X POST http://127.0.0.1:3210/api/codex/model-policy/restore \
  -H 'Content-Type: application/json' -d '{"target":"previous"}'
curl --fail -X POST http://127.0.0.1:3210/api/codex/model-policy/restore \
  -H 'Content-Type: application/json' -d '{"target":"builtin"}'
```

Password-protected installations use the signed-in settings page or supply an
authenticated session cookie and an allowed Origin. The corresponding WebSocket
commands are `settings.readCodexModelPolicy`, `settings.refreshCodexModelPolicy`
and `settings.restoreCodexModelPolicy` with `target: "previous" | "builtin"`.
The GET response includes schema version, content revision, effective policy,
source, configuration path, warning and previous-version availability. Responses
are not cached. The `codex-model-policy` subscription broadcasts accepted updates
and rejection warnings.

Refresh validates the whole file before switching. Invalid JSON, unsupported
schema versions, duplicate IDs/aliases, invalid capabilities and missing roles
are rejected; the active catalog and recovery journal stay usable. A serialized
writer saves the current and previous accepted policy atomically in
`codex-model-policy-state.json` before publishing. Startup with an unreadable or
missing override uses the last accepted policy; unreadable recovery state falls
back to the bundled catalog. A missing local file is recreated from the effective
policy. Restore previous/defaults also updates the editable file, so the restored
configuration remains active after restarting. This overwrites local edits in
that file; save a copy first if those edits are needed.

`src/shared/codex-model-policy.json` remains the bundled recovery baseline.
Changing that baseline still requires a build/release, but ordinary model
upgrades use the external file. Codex CLI itself is installed separately and can
be upgraded without rebuilding StillOn when its protocol remains compatible.
Manual discovery through Codex `model/list` uses explicit selection and
confirmation. Reloading the local file works without discovery or inference.

The authenticated POST `/api/codex/model-policy/discover` returns a selection
draft, leaving the active policy untouched. POST `/api/codex/model-policy/apply`
accepts `{ "draftId": "…", "modelIds": ["…"], "roles": { "conversation": "…",
"background": "…" } }`; model IDs and capabilities are validated against the
server-owned draft. Mutations use the same authentication and Origin checks as
refresh/restore. WebSocket commands are `settings.discoverCodexModels` and
`settings.applyCodexModelSelection` (with `selection` containing that payload).

Run `bun run check` and `bun run test` before merging an application change.
Runtime policy tests cover atomic rejection, restart recovery, restoration,
normalization, two-client updates, reconnect ordering and preserved history.
