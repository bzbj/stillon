# Claude Code model configuration

Open **Settings → Providers → Claude Code Model Configuration**. After updating
Claude Code, click **Fetch models from Claude Code**, select the models to enable,
and **Confirm and apply**. Discovery uses the installed CLI's SDK metadata channel
(`supportedModels`) without submitting a user message or starting an inference
turn. The current catalog stays active until confirmation.

Canonical `resolvedModel` IDs are preferred over moving aliases such as `sonnet`.
A newly returned model is added as an unchecked candidate. Existing enabled models
remain selected even when absent from the response. To use a model the CLI does
not enumerate, enter its exact ID and click **Add model**, then confirm. Manual
IDs must be supported by the installed CLI and account; adding an ID does not
verify remote availability. New models use only the capabilities reported by the
CLI; manual models start without effort or extended-context controls.

Choose **Configure models** to edit the enabled selection without discovery.
The fallback chat model is used when a saved preference is absent or no longer
selectable. Valid saved preferences take priority: set the desired model under
**Claude Code Defaults** to change new-chat preferences.

The accepted catalog is stored atomically in the server data directory as
`claude-model-policy.json`, outside the installed runtime. It survives restarts
and application upgrades. Connected clients receive the catalog before settings
or chat preference normalization, including reconnects. Active turns and stored
chat history are preserved. Invalid selections, stale concurrent saves, failed
writes and failed discovery leave the accepted catalog unchanged. Discovery is
explicit, shares concurrent requests and has a 20-second timeout.

Both local and authenticated Connect entries use the same configuration.
WebSocket commands are `settings.readClaudeModelPolicy`,
`settings.discoverClaudeModels`, and `settings.applyClaudeModelSelection`.
The corresponding HTTP routes are GET `/api/claude/model-policy` and POST
`/api/claude/model-policy/discover` / `/api/claude/model-policy/apply`.
Apply accepts `{ "baseRevision": "…", "policy": { "models": […],
"defaultModel": "…" } }`. Authentication, ingress and Origin checks apply.
The response is not cached. Malformed configuration files at startup fall back
to bundled models with a visible warning; saving a valid selection recovers them.
