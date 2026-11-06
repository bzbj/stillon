# Bundled optional integrations

Status: development preview. Production installations have not been upgraded.
The product ships the DeepSeek Harness adapter with StillOn, disabled by
default. This replaces the earlier user-installed add-on proposal. The CodeBuddy
CLI adapter that previously shipped beside it has been removed.
The internal add-on protocol and isolated adapter modules remain in use.

## User experience

- Codex and Claude Code retain their built-in setup and chat behavior.
- **Settings -> Integrations** always lists DeepSeek Harness (Preview) with an
  Enable/Disable switch.
- New installations start with the integration disabled. Only enabled,
  compatible integrations appear in Providers and new-chat menus.
- Enabling shows the local CLI check and a link directly to that provider's
  configuration. Missing CLI, missing authentication and incompatible versions
  remain distinct states; enabling an adapter is not proof of authentication.
- Disabled adapters do not launch a process or probe the vendor CLI. Active
  checks/chats must finish before disabling. The settings page refreshes busy
  state after CLI checks and while open.
- Disabling keeps model choices, native credentials, chat history and vendor
  session IDs. Existing chats remain readable and explain how to re-enable their
  integration; they never silently switch to another provider.
- Existing `/settings/addons` links and remembered navigation still open the
  Integrations page. Ordinary users no longer import, uninstall or roll back
  individual package files.

Only the StillOn adapter is included. Users install and update the public
vendor CLI and manage native login separately. No DeepSeek Harness, vendor
desktop app or matching vendor SDK/runtime is embedded.

## Build and runtime boundary

`bun run build` builds the adapter and both browser clients. `bun run dev` and
`bun run dev:server` prepare adapters before starting development servers.
`bun scripts/build-desktop.ts` builds fresh adapters directly into the staged
desktop payload before sealing its runtime manifest and archive.

```text
<runtime>/dist/integrations/deepseek.stillon-addon
<data-root>/addons/<provider>/<version>/manifest.json
<data-root>/addons/<provider>/<version>/adapter.js
<data-root>/addons/<provider>/models.json
<data-root>/addons/installed.json
```

The JSON envelope contains a validated manifest and prebundled adapter code with
a SHA-256 digest. The desktop runtime manifest additionally seals those files.
Source-only `addons/` and developer `dist/addons/` outputs remain excluded from
the desktop payload. The normal package file list includes `dist/integrations/`.
End users need no build tools, Node installation or separate adapter download.

At startup, the host validates and caches its bundled immutable adapters without
launching them. New records get `enabled: false`. Existing records keep their
enabled flag and saved model policy, including migration from earlier imported
preview packages. The active StillOn runtime selects the adapter version: app
updates and rollback select their respective bundled versions. Package caches
are retained, and unchanged startup does not rewrite the registry.

An unreadable/corrupt bundle is unavailable, preserving user preferences and
leaving the other providers usable. A corrupt registry is preserved and requires
recovery; it is never silently replaced. Unknown platforms and CLI versions
fail with an explicit compatibility message. Bundled adapters cannot be replaced,
removed or independently rolled back through the old package-management API.
Its standalone installation path remains for development protocol fixtures.

The host owns each adapter process and launches it with the bundled Bun runtime.
Versioned stdio messages cover status, start/resume, transcript events, questions,
permissions and Stop. Host/Connect/updater credentials are stripped from the
adapter environment. The selected workspace is passed as the vendor CLI cwd.
Process isolation contains crashes; it is not an operating-system sandbox.

## DeepSeek models and credentials

DeepSeek's adapter supports native provider configuration, endpoint model
discovery and saved enabled-model policies. It calls the installed Harness's
public `dsh --profile sdk --patch` extension mechanism; it never imports private
desktop internals. Native credentials are write-only in settings and remain in
the vendor credential store. Model policies are independent of adapter versions.
See [DeepSeek setup](../addons/deepseek/README.md) and the
[protocol notes](deepseek-local-harness.md).

Preview targets are **Windows x64 / ARM64 and macOS Intel / Apple Silicon**. DeepSeek uses
**dsh 0.2.1-rc.5 on Windows**, **0.2.2-rc.1 on Mac**.
Shipping the adapter does not establish compatibility
with other vendor versions or platforms.

## Access and qualification

Toggle and native configuration writes remain local-owner operations with exact
origin checks. Remote clients consume the enabled provider catalog and use chats
under existing account and workspace permissions. Shared/invited workspaces do
not gain host-wide integration management. Remote configuration is a product gap.

Relevant verification commands:

```sh
bun run check
bun run audit
bun test src/server/provider-addons.test.ts src/server/provider-addon-windows.test.ts
bun scripts/verify-deepseek-models.ts --run
bun scripts/verify-macos-integrations.ts --run
bun scripts/verify-provider-cli-windows.ts --run
bun scripts/build-desktop.ts --runtime-only
bun scripts/verify-bundled-integrations.ts
```

Process-backed tests cover disabled startup, independent owner-only toggles,
active-turn protection, imported-preview migration, app update/rollback with
retained models and sessions, corrupt bundle/registry behavior and platform gates.
The opt-in BYOK test uses real public dsh with an isolated native home, a synthetic
key and a loopback model endpoint. Packaged-runtime verification extracts the
actual archive and uses embedded Bun with an isolated home and data directory;
it never installs a service or touches the production port.

Native installer replacement/upgrade, real authenticated managed Connect,
and other platforms still need acceptance.
On Windows ARM64, the StillOn host and the vendor CLI can use different CPU
architectures. A public CLI launched by x64 Node uses Windows emulation and
requires x64 native dependencies. Install it with the Node/npm runtime that will
launch it; do not omit vendor native optional dependencies or select them solely
from the architecture of StillOn's Bun runtime. StillOn does not install or
replace the vendor runtime.

Windows ARM64 regression checks use the native Bun host and the unmodified bundled
packages, including their version handshake. Public Windows `.cmd` launcher checks
round-trip Unicode text and a workspace path with spaces. The opt-in Windows CLI
check initializes the supported dsh version in an isolated home and confirms
shutdown; it sends no model request and does not establish authenticated inference.

The development preview is not a qualified release.

### Local verification record

- Type checking, both client builds, bundled adapter builds and dependency audit
  passed. Focused coverage totals 199 passing tests and one POSIX-only skip across
  12 files. An old error-message assertion was updated and its seven-test suite
  rerun successfully.
- Browser checks passed for first-run disabled switches, chat-menu filtering,
  independent enable/disable and reload, native CLI detection, direct provider
  configuration links, model-list save and preservation after re-enabling, and
  write-only key fields. CLI-check completion refreshes the switch's busy state.
- Real public dsh passed the bundled-adapter BYOK flow through the coordinator
  using an isolated native home, synthetic credential and loopback model server.
- A Windows x64 runtime archive was built and extracted into an isolated profile.
  Its embedded Bun started the packaged server with a clean PATH, served the
  settings shell and verified both bundled defaults, owner toggles and restart
  persistence. Initial execution directly from build staging failed reading a
  dependency with EPERM; the actual extracted distribution passed. No system
  security setting or installed service was changed.
- This verifies runtime assembly and isolated startup, not native installer
  replacement, a production service upgrade or managed Connect acceptance.
