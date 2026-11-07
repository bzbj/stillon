# DeepSeek Harness optional integration

Development package version: **0.2.0-preview.5**, StillOn add-on API **1**.
Preview targets: Windows x64 / ARM64 and macOS Intel / Apple Silicon.
The adapter discovers the installed public `dsh` without requiring a particular
CLI version. Compatibility is determined by the SDK operations used, rather than
a version allowlist. CI uses reproducible CLI versions (**0.2.1-rc.5** on Windows
and **0.2.2-rc.1** on macOS); these are test fixtures, not runtime requirements.

StillOn includes this adapter, disabled by default. Open **Settings -> Integrations
-> DeepSeek Harness -> Enable**, then follow **Configure Harness models and
credentials**. Adapter updates ship with StillOn; the vendor CLI remains local.

For standalone development fixtures, build from the repository root:

```sh
bun scripts/build-provider-addon.ts
```

This produces `dist/addons/deepseek-0.2.0-preview.5.stillon-addon`, a JSON envelope with
validated manifest metadata and a self-contained JavaScript adapter. The script
digest detects corruption; this locally imported development package is not an
authenticated online catalog release. Only import packages from trusted sources.

Open **Providers -> DeepSeek Harness** after enabling it to check the
user's local Harness installation. The model service panel reuses native credentials,
can save a new API key, and supports existing provider routes or custom BYOK endpoints.
StillOn does not install another Harness or import existing secret values.

On macOS, use the public CLI from a compatible Harness Desktop installation or
install the public CLI with Node.js 24:

```sh
npm install -g @deepseek-ai/dsh
dsh --version
```

The npm route works on both Intel and Apple Silicon; the vendor's Desktop download
may only offer Apple Silicon. StillOn checks PATH, `/Applications/DeepSeek Harness.app`
and `~/Applications/DeepSeek Harness.app`. **Configure → Use an existing CLI** can
select another public launcher. A selected missing launcher reports an error. A different CLI version is
accepted; SDK protocol failures are reported when an operation is attempted. Configure account access in Harness or API access in StillOn's
local model service panel, then discover and save the enabled models.

Use **Discover loaded models**, select the models to enable, choose a default,
and **Save chat model list**. Discovery is a draft; failed discovery leaves the
saved list intact. Models retain their native provider identity and reasoning
levels. The original two DeepSeek API models remain the initial compatibility
catalog until the first save. Saved lists survive host/add-on upgrades and restarts.

Configuration uses the public `dsh --profile sdk --patch <temporary-overlay>`
extension mechanism. A small StillOn plugin calls the documented `llm`, `settings`
and `credentials` services; it does not read Desktop internals or implement a
second model API client. Native settings edits preserve unrelated fields and
providers, persist in the Harness **sdk profile**, and use native validation and
atomic writes. A new API key gets a fresh reference in the native credential store;
only its configured state is returned. Empty key fields preserve authentication.
Account sign-in remains in Harness. Service edits require StillOn's Harness chats
to be idle. Other SDK clients using that same profile observe the saved changes.

For custom endpoints, **Fetch endpoint models** fills a draft of model IDs. Enter
IDs manually if the endpoint has no listing. Save the service, discover its loaded
models, then enable them for chats. Built-in routes use the vendor's catalog.

The host runs the adapter with its bundled Bun executable. The package
does not require the source repository, npm installation, or a separate SDK at
runtime. The desktop payload includes compiled adapters in `dist/integrations/`;
it does not include `addons/` sources or developer `dist/addons/` outputs.

Installed versions live under `<data-root>/addons/deepseek/<version>/`.
Disabling requires the provider to be idle and preserves model settings, chat
history and vendor sessions. Host upgrades/rollback select their bundled adapter
version while retaining the user's enabled flag and saved models. There is no
separate user-facing package installation, uninstallation or rollback step.

The adapter uses `dsh --profile sdk` over stdio and owns its process lifetime.
Resume, committed text, tool events, permissions and user questions are supported.
Forking, incremental token streaming, native image input and cost reporting are
not implemented. The main app continues to support Codex and Claude independently.

Checks:

```sh
bun test src/server/provider-addons.test.ts src/server/deepseek-harness.test.ts
bun scripts/verify-deepseek-models.ts --run
bun scripts/verify-deepseek-live.ts --run
```

The model-settings check uses a real public CLI with an isolated Harness home,
synthetic credentials, and a loopback OpenAI-compatible endpoint. It verifies
native save/read, key redaction, model discovery, policy persistence and actual
model routing without calling an external inference API.
The last command consumes real API usage and exercises a separately built and
installed add-on in an isolated workspace. See
[the add-on architecture](../../docs/provider-add-on-packages.md) for the remaining
distribution, cross-platform and managed Connect acceptance work.

Configuration and model-list writes are local-owner only; authenticated Connect
clients consume the saved list and use chats under existing workspace permissions.
Mac CLI acceptance uses isolated native homes and a loopback model endpoint; see
`bun scripts/verify-macos-integrations.ts --run`. Vendor-account inference and
Desktop-only installation/upgrade acceptance remain separate from this CLI preview.
