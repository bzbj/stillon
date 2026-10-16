# Desktop distribution and customization

## Product contract

StillOn ships four native runtime variants: macOS Intel (x64), macOS Apple Silicon
(arm64), Windows x64, and Windows ARM64 (including ARM Surface devices). Each
contains Bun, server dependencies, both built web clients, and the independent
updater. An ordinary install or update never invokes Git, a package manager, or a
frontend build on the user's machine. Provider CLIs and their authentication remain
external prerequisites.

macOS uses a DMG containing StillOn.app; Windows uses a per-user EXE installer.
The desktop launcher opens the browser workspace and installs the native per-user
service on first launch. The updater lives outside the app payload so replacing a
runtime cannot terminate its own transaction. Updates download official release
artifacts, validate metadata and SHA-256, stage an immutable runtime, probe it,
check idle state, back up data, switch, verify, and roll back on failure.

## Ownership of files

- Installed application: immutable vendor payload; never a place for personal CSS,
  settings, keys, or chat history.
- ManagedUpdates: controller, versioned runtime payloads, journals, rollback data.
- User data root (`~/.stillon`): history, settings, themes, skins, UI preferences.
  Installation and uninstallation preserve it; transactional rollback restores a
  matched snapshot only before allowing new user work.
- Project workspaces and provider data: outside the installer/update boundary.

## Customization

Settings → Appearance implements theme palettes and editable colors, fonts, size,
corners, density, panel style, sidebar width, conversation width and local image
backgrounds. Drafts preview before applying and revert after 60 seconds, on cancel
or when leaving the page. Applied settings synchronize through the existing
settings channel and survive refresh. Restore defaults remains available in safe
mode at `/settings/appearance?safe-mode=1`.

Preferences are stored in `.stillon/data/settings.json`. Images and portable skin
packages are stored under `.stillon/data/customizations/appearance/`, outside the
immutable runtime. Install/update/uninstall preserve that user data; rollback
restores originals and quarantines failed-version changes.

The data-only theme/UI API is version 1. Skin files are bounded JSON containing
validated preferences and an optional embedded PNG/JPEG/WebP background, with no
external asset paths or executable hooks. Unsupported API versions are retained
on disk without changing the active appearance. See [appearance API and recovery](appearance.md)
for schema, public component hooks and import/export instructions.

Primitive palette values map to semantic CSS variables, then stable component
aliases for sidebar, conversation and composer. Arbitrary component behavior and
executable extension APIs remain future product work. Pet development is paused
and is excluded from this implementation.

## Acceptance

- Fresh installations run without Git/Bun/npm in PATH; package architecture is
  checked, including actual ARM64 Bun execution on Windows ARM.
- No source build on install/update; prepared bundles reused after configuration
  and runtime checks.
- Failed downloads, wrong architecture, bad digest, altered payload, active work,
  interrupted worker and failed app health produce a recoverable result.
- Settings and sample custom theme/skin files survive successful update byte for
  byte; failed-version modifications quarantined and originals restored.
- Native install, start, restart, upgrade and uninstall tested on each runner.
  Physical Surface, Gatekeeper/notarization and interactive install UX have
  separate acceptance evidence.
- Beta release installers are deliberately unsigned and labelled in filenames and
  release notes. Platform signing remains optional; signing secrets are never committed.

## Install, update and uninstall

On macOS, download the DMG for Intel or Apple Silicon, drag StillOn to Applications,
and open it. Confirm first-time background setup. To remove background services,
hold Option while opening StillOn and choose Remove background services, then
remove the app from Applications.

On Windows, use the x64 EXE for Intel/AMD PCs or the ARM64 EXE for Windows on Arm.
The installer is per-user and adds a Start menu entry. First launch confirms the
background service. Windows Settings -> Apps -> StillOn -> Uninstall stops the
owned services before removing the desktop files. Active agent/terminal work must
finish first. User data is preserved on both platforms.

In Settings -> Changelog, Prepare only downloads and verifies the package without
switching. Upgrade reuses a still-valid prepared package and checks the current
runtime/configuration again. Package installations never replay source patches.
A recorded, healthy managed source installation can migrate once: open the app
and confirm **Migrate to installer version**. Finish agent tasks and close embedded
terminals first. Chats, appearance assets, provider/Connect data and service
options including the environment file are retained. Source edits remain in the
previous runtime; the confirmation explains they are not applied to package code.
Runtime-local data, unknown/custom services and changed registrations still require
review. No migration, installation or package update invokes Git or a build.

An independent native recovery task stages a new immutable controller with bundled
Bun, journals the service/controller handover, backs up stopped data and switches.
It shares the updater lease and excludes competing requests. It restores the
original native definitions, deployment, ownership and matched data on failure;
interrupted switches recover after login. The prior source runtime is retained.
Future updates use the prebuilt package channel. Source-only or incomplete releases
are shown as awaiting installer availability, never as a source-build fallback.

Opening a newer downloaded app asks to upgrade the managed runtime, not just its
launcher. The same version opens the existing workspace; an older installed launcher opens the current workspace and refuses an explicit
downgrade. Closing the initiating launcher does not stop recovery.
The embedded CLI exposes `desktop --migrate` and `desktop --update` for these
explicit operations; existing pending transactions resume rather than duplicate.

## Build and signing

```
bun install --frozen-lockfile
bun run check
bun run build:desktop
bun run verify:desktop
```

Run natively on each target architecture. Windows requires the Inno Setup compiler
(`scripts/install-inno-setup.ps1` installs a pinned, SHA-256 verified CI version).
Artifacts are in `dist/desktop/release`; runtime/installer acceptance reports are in
`dist/desktop/reports`. `verify-desktop.ts --native` is restricted to disposable CI
runners because it exercises real per-user native service registrations.

The release workflow waits for all four installer jobs, validates their archive
hashes, uploads packages/installers, then publishes `stillon-release.json` last.
Updates fetch metadata only from the official GitHub release over HTTPS, and verify
archive and per-file SHA-256. These checks rely on the official GitHub publication
trust boundary; the metadata is not a separately signed offline update feed.

Signing secrets: `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`,
`MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`,
`WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`.
A hardware-backed/cloud Windows signing service can replace `sign-windows.ps1`.
Normal beta publication uses unsigned installers and does not require signing
credentials. Setting `require-signing` explicitly enables the optional signed path. No signing credentials are bundled.
An explicitly selected [source-only release](releasing.md#source-only-publication)
publishes no desktop installers or package update manifest. Its unsigned development
installers remain in GitHub Actions, built at the exact release tag and linked
from the notes. Source-only publication deliberately omits the package update channel.
Run the Desktop installers workflow manually with `require-signing` enabled to
validate signed artifacts before publishing a release; manual builds only upload
CI artifacts and never publish release assets.

The macOS build signs Bun before creating the file manifest, verifies native helper
signatures, then signs and notarizes the containing app/DMG, following
[Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Windows signs the launcher, installer and uninstaller through
[Inno Setup's SignTool integration](https://jrsoftware.org/ishelp/topic_setup_signtool.htm).
These production signing paths require acceptance with the project's certificates;
successful unsigned CI builds do not demonstrate trusted signature validation.

The controller protocol starts at 1. Each runtime declares the minimum compatible
updater protocol; an incompatible future release fails before switching. Controller
replacement during migration or an installer upgrade is a journaled maintenance
transaction performed by a distinct recovery helper. It stages immutable files
and restores the original native registrations on failure; it never overwrites
a running helper. Normal in-app runtime updates keep the controller pinned.
