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

## Customization architecture (planned API)

Keeping files and maintaining rendering compatibility are separate promises.
Upgrades must always preserve user files. Rendering guarantees are tied to a
versioned public interface, not private React structure or Tailwind class names.

| Layer | User changes | Storage | Compatibility |
| --- | --- | --- | --- |
| Theme | Colors, font roles, radius, spacing and density | `~/.stillon/customizations/themes/<id>/theme.json` | Versioned semantic tokens; unknown tokens ignored with diagnostics |
| Skin | Theme plus local fonts, images, icon overrides and optional CSS | `~/.stillon/customizations/skins/<id>/` | `skin.json` declares API range; public `data-stillon-part` hooks |
| UI preferences | Supported sidebar width, panel visibility/order and density | User settings, with a schema version | Validated settings migrated additively; original retained on failure |
| UI extensions | New panels/actions/renderers through named slots | `~/.stillon/customizations/extensions/<id>/` | Future versioned host API and explicit capabilities; no arbitrary code loader in v1 |
| Source customization | Arbitrary component/behavior changes | Developer checkout plus saved patch | Explicit source-build channel; conflicts require review, no overwrite |

Token layers are primitive values -> semantic roles -> component aliases.
Examples: `palette.accent` -> `color.action` -> `button.primary.background`.
Existing CSS variables (background, foreground, primary, border, radius) provide a
migration starting point. New public names must have documented value types,
light/dark variants, defaults, and deprecation aliases. Skin CSS loads after the
vendor stylesheet and targets documented hooks. Arbitrary private selectors are
best-effort and may need edits after structural UI changes.

A skin package declares `schemaVersion`, `id`, `name`, `version`, `themeApi`,
`uiApi`, token overrides, and local asset references. Paths must stay inside the
package. Assets are served through authenticated app routes; skin imports do not
load remote scripts or execute installation hooks. A future executable UI plugin
needs a separate capability and isolation design, not CSS privileges.

Settings -> Appearance should offer import/export, preview, apply, and restore
defaults. Preview is reversible until confirmed. Invalid/incompatible packages
remain on disk but are disabled with a useful reason. `?safe-mode=1` loads the
vendor UI and exposes recovery controls even when custom CSS hid normal settings.
Safe mode suppresses all custom CSS and future extensions before they load.
Failed migrations retain originals and never silently rewrite user packages.

## Delivery stages

1. Ship bundled runtimes, native installers and artifact-backed updates. Test
   user-owned settings/theme/skin fixture preservation through success and rollback.
2. Add semantic theme tokens, skin manifest/import/export and public UI hooks,
   with safe mode and light/dark/accessibility checks. Migrate existing custom CSS
   and icon/font edits into user packages where feasible; show a migration report.
3. Add supported layout preferences, then design panel/action extension APIs from
   concrete UI-change requirements. Arbitrary component replacements continue
   through the source channel until an explicit supported API exists.

Stage 1 establishes the storage/update invariant. The theme editor, package loader
and extension SDK are subsequent product work; do not describe them as implemented
just because the installer preserves their directories.

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
- Public release installers require trusted OS signing. Unsigned CI artifacts are
  development builds and labelled as such; signing secrets are never committed.

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
Source installations retain the existing source updater; the desktop installer
detects them and refuses to replace their service or customizations implicitly.
Migration into the package channel requires a separate reviewed migration; current
source changes must be exported/moved into supported theme/skin interfaces first.

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
Missing signing credentials fail public installer publication; PR builds remain
available for development acceptance. No signing credentials are bundled.
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
replacement remains a separate maintenance transaction, never an overwrite of a
running helper. A subsequent controller upgrade mechanism must retain this boundary.
