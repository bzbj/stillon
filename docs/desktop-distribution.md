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
- Transport/frp: independently downloaded, immutable Connect helpers shared by
  runtime versions; kept outside ManagedUpdates and user-data rollback snapshots.
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

Desktop setup and upgrade waits allow up to 15 minutes per service/setup phase.
The independent transition is polled for success, rollback or recovery, with
phase messages shown by the Windows launcher while work continues. A transition
wait expiring explains that the background update is still running; it does not
cancel or duplicate the worker. Browser opening is best effort after the service
is ready, including Explorer's successful URL handoff with exit code 1. If the
browser handler fails, the desktop command still succeeds and prints the local
workspace URL.

Windows launcher progress, command completion, bounded stdout/stderr and errors
are recorded in `%LOCALAPPDATA%/StillOn/launcher.log`. Error dialogs include the
log path. Logs rotate after 2 MiB, keeping one previous file; failure to write a
log does not prevent startup. `desktop --no-open` continues to suppress browser
opening.

## Build and signing

Official desktop releases require the repository Actions variable
`STILLON_CONNECT_ORIGIN` to contain the managed service's public HTTPS origin.
`STILLON_CONNECT_MIGRATE_FROM_ORIGINS` optionally contains a JSON array of exact
previous origins that the same operator has approved for migration. The release
workflow passes both values into all four native builds and verifies the sealed
`runtime/connect.json`, the pinned component requirement and fresh-profile binding configuration.
Missing, insecure or example origins fail managed publication before building.

An approved migration retains device keys, computer ID, account binding, pause
and pending revocation actions. It updates only the approved service and matching
public URLs. Unrelated self-hosted services and overrides are preserved. Both
saved files are replaced atomically and an interrupted migration converges on
restart. Keep the old device API/tunnel bridge until existing computers have
migrated. Browsers need a fresh login on a different domain.

Manual/local builds remain available: omit the origin with `require-connect`
disabled for local-only use, or supply an explicit HTTPS self-hosted origin.
For a managed command-line build, set `STILLON_REQUIRE_CONNECT=1` and
`STILLON_CONNECT_ORIGIN`; use `STILLON_CONNECT_MIGRATE_FROM_ORIGINS` only when the
old and new services share the same account/device authority. Never place mail
credentials or private configuration in these public package inputs.

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

## Independent Connect component

The application payload contains `runtime/frp-component.json`, not an frpc
executable. It seals the required upstream version, platform, architecture,
HTTPS archive URL, archive SHA-256 and installed executable SHA-256/size.
Building StillOn reads this small requirement without downloading, extracting
or executing frpc.

First-time desktop setup downloads and verifies the component before starting
background services, so a successful component setup is ready for email linking
without another download. An otherwise healthy local installation remains usable
if downloading or running the helper fails; Remote access shows the component
failure and an explicit **Repair Connect component** action. A cold start under
an older updater controller may make one asynchronous preparation attempt; local
HTTP readiness never waits for it. Isolated update probes do not prepare helpers.

Shared roots are:

- Windows: `%LOCALAPPDATA%\StillOn\Transport\frp\`.
- macOS: `~/Library/Application Support/StillOn/Transport/frp/`.

Each root contains `<version>-<architecture>-<executable-hash-prefix>/frpc[.exe]`
and the upstream license. The content suffix keeps different component bytes
at the same upstream version separate for running instances and rollback. A
cache hit verifies the executable against the **runtime's sealed requirement**;
it does not trust a mutable cache manifest, write files, run a version probe or
make a network request. Matching legacy bundled bytes can seed the shared cache.
Application uninstall preserves it, alongside other user-owned data.

Downloads are bounded and both archive and executable digests must match before
execution. Archive paths and links are never extracted to disk. One writer owns
the component preparation lock; durable attempt receipts prevent repeated
downloads after interruption, failed verification or removal/quarantine. An
explicit local repair can retry. Remote/external callers cannot manage the
component. No operation disables Defender, Smart App Control or Gatekeeper,
changes exclusions, removes quarantine attributes, or promises permanent trust.

The checked-in `src/server/connect/frp-components.json` pins the upstream
**unsigned** 0.71.1 artifacts, matching the existing unsigned beta channel.
Setup downloads directly from the pinned upstream release. This component flow
does not use signing certificates, notarization credentials or a separate
StillOn component build/publication workflow. When changing frp, update the
target descriptors and verify both archive and executable hashes. Subsequent
StillOn upgrades reuse the cache while those requirements remain unchanged.
