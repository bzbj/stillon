# Runtime Codex model configuration

StillOn reads its selectable Codex models, capabilities, aliases and default
roles from `<data directory>/codex-model-policy.json` (normally
`~/.stillon/data/codex-model-policy.json`). It creates this editable file on first
startup. The file lives outside the installed runtime and survives application
updates. Model catalog changes no longer require a frontend rebuild or an
application release.

Edit the local JSON, then open **Settings → Providers → Codex Model
Configuration → Refresh models**. Connected clients update automatically,
including their model menus, supported reasoning efforts and Fast option.
Clients that reconnect receive the active policy before settings or chat
preferences are normalized. Saved valid preferences are preserved; aliases
migrate replaced model IDs and unsupported options normalize to valid values.
Unknown IDs fall back to the conversation role. Historical transcript entries
and current turn preferences are not rewritten, and refresh does not restart
agent sessions. A subsequent turn uses the refreshed catalog.

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
Automatic discovery through Codex `model/list` is optional future work; runtime
refresh deliberately works without a discovery or inference request.

Run `bun run check` and `bun run test` before merging an application change.
Runtime policy tests cover atomic rejection, restart recovery, restoration,
normalization, two-client updates, reconnect ordering and preserved history.
