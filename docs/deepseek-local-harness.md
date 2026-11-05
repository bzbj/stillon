# Local DeepSeek Harness (experimental)

StillOn's DeepSeek provider launches the user's public `dsh --profile sdk` CLI
and exchanges newline-delimited JSON-RPC over stdio. It does not ship a second
Harness, import Desktop's internal packages, or require a matching npm SDK.
The selected runtime is initialized with the provider/model pair chosen from
Harness discovery. `deepseek-official` uses an API key; `deepseek-account` uses
the Harness account; custom providers can use BYOK. These routes remain distinct.

## Setup and operation

1. Install DeepSeek Harness and configure its account or model API access.
2. In a StillOn build containing the optional integrations, open **Settings →
   Integrations → DeepSeek Harness → Enable**. The adapter ships with StillOn;
   no separate package import is needed. See the [adapter README](../addons/deepseek/README.md).
3. In StillOn, open Settings → Providers → DeepSeek Harness and recheck installation.
   Detection checks an explicit `DSH_EXECUTABLE`, PATH, Windows install metadata,
   and standard Desktop locations. The local settings page can select a public
   launcher manually. A missing explicit launcher is an error, not a fallback.
4. In the model service panel, keep existing Harness configuration or save an
   endpoint, protocol and API key. Changes target the **sdk profile**, with keys
   written through Harness's native credential store. Account sign-in stays in Harness.
5. **Discover loaded models**, choose the enabled models and default, and save the
   chat list. Chat selectors use this persisted list, including model-specific
   reasoning levels. Discovery alone does not replace it. The original Flash/Pro
   catalog is retained until the first save for compatibility with older chats.
6. Choose **DeepSeek Harness** in a new chat. Models are qualified by their native
   provider; changing defaults never silently reroutes an existing chat. A disabled
   model must be explicitly selected or re-enabled before continuing that chat.

Installation status verifies the launcher and version; it does not claim the key
is valid. The first real request reports authentication or model errors. Manage
runtime updates through DeepSeek Harness itself. StillOn's model service panel
can save new API keys but never returns existing values.
StillOn does not replace or update this installation.

Each turn owns an add-on process and its CLI process. Subsequent turns restore the durable Harness
session with `session/resume`. Stop shuts down the owned runtime, with a forced
Windows process-tree cleanup if necessary, and waits for confirmed process exit
before allowing another writer. This uses the public process lifetime because
the tested SDK does not expose a per-turn cancellation RPC.

Permissions are passed through the shipped SDK profile's `DSH_PERMISSION_MODE`
setting: Workspace Access uses `workspace-write`, Full Access uses
`danger-full-access`. This avoids the newer `session/query` RPC absent in the
tested Desktop release. Users who customize their SDK profile must retain the
profile's permission setting. Approval requests and native user questions appear
in StillOn; dismissing a question never grants permission. Only visible assistant
text and tool events enter the StillOn transcript, not raw request configuration.

## Verification and limits

The local Windows CLI **0.2.1-rc.5** has passed real `deepseek-official` Flash
inference, file reading, process restart/session resume, and cancellation through
StillOn's coordinator. Protocol and launcher tests cover response ordering,
split UTF-8, Windows quoting, non-Windows command construction, privacy filtering,
permission boot settings, host questions, and rejection.

Run the optional real-model check with:

```sh
bun scripts/verify-deepseek-live.ts --run
```

It consumes local API usage, creates a dedicated workspace under ignored
`test-artifacts/deepseek-live`, and creates normal test sessions in Harness.
No API key is read, copied, or logged by the test. Start an isolated local preview
with `bun scripts/dev-deepseek.ts` at `http://127.0.0.1:3217`. The preview
uses a separate StillOn home as well as a separate data directory, while
`DSH_HOME` continues to point at the installed Harness. It does not copy keys.

This is a trial integration. Session forking, native slash commands, import of
existing Desktop history, incremental token streaming, and usage/cost reporting
are not implemented. macOS/Linux installations and future runtime releases still
need live qualification. Changing the user's SDK profile can change capabilities.
Model discovery reads the installed runtime's `llm` services through its public
plugin extension, rather than guessing a new SDK RPC. A custom endpoint's model
listing is a separate explicit fetch; saving those IDs activates them in Harness.
Profiles with custom plugin composition must retain the public settings and
credential services. Native default reasoning on resumed sessions follows the
SDK's session semantics; choose an explicit effort to override a persisted level.

Managed Connect acceptance requires the private service fixture for this exact
revision. Local testing alone does not qualify this feature for release. No
installed StillOn service, managed update metadata, ingress, or production data
is changed by this development preview.

Protocol reference: [official SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/protocol).

### Local verification record

- `bun run check`: passed (TypeScript and both production bundles).
- `bun run audit`: passed using the repository's existing advisory exclusion.
- Final focused run: 108 passed, 1 platform-specific test skipped, 0 failed.
- Live coordinator: API inference, file read, durable resume and Stop passed.
- Browser: local CLI detection and a real Flash reply passed; persisted chat
  survived a preview server restart.
- The initial full suite did not pass: 1,535 passed, 14 skipped, 34 failed, with
  4 additional errors. This run began before final fixes; the focused rerun
  covers the changed adapter/settings expectations. Other failures include
  updater/Connect timeouts and Windows link/process fixtures. Four settings
  assertions also fail when run alone at unchanged upstream revision `2b1d6a4`.
- Browser also reports an existing workspace-sharing timer binding error;
  the DeepSeek chat path remains usable. Managed Connect and cross-platform
  live acceptance remain outstanding. This is not release qualification.
