# Releasing StillOn

StillOn is released from GitHub source; it does not publish an npm package.
A GitHub Release is the source for the in-app changelog. On an explicitly enabled
[managed deployment](managed-updates.md), **Settings → Changelog** offers
**Prepare only** and **Upgrade to …** for newer stable releases. An independent
native updater downloads prebuilt runtime archives for package users and retains
source builds for source installations. Publishing
a release does not automatically install it. Unsupported installations retain
an instantly generated, copyable source-upgrade prompt. Deployment inspection
happens when a coding agent executes that prompt, not while generating it.

## Triggering a release

Merging a pull request never creates a release automatically. After the desired
changes are on `main`, the owner explicitly requests a version, for example:

> Release `0.1.1`.

The release operator then follows the process below. This keeps version bumps,
release notes, tags, and public publication intentional.

## Version rules

Use semantic versions:

- patch (`0.1.1`) for fixes and small polish;
- minor (`0.2.0`) for backward-compatible features;
- major (`1.0.0`) for breaking behavior or data changes.

`package.json` is the single version source. The corresponding annotated Git
tag must be `vX.Y.Z`; the release workflow validates that relationship before
uploading assets.

Working-dog edition names supplement semantic versions and never replace the
numeric tag. All `0.x` releases belong to the **Husky** edition; **Corgi** begins
at `1.0.0` after the graduation gates in the [release roadmap](roadmap.md) are
met. Patch and minor releases do not advance the edition automatically.

## Release procedure

1. Work from a clean, up-to-date `main` checkout. Do not release from a
   feature branch or a worktree containing unrelated changes.
2. Review commits since the latest tag and confirm the requested version.
   For desktop publication, confirm repository Actions variable
   `STILLON_CONNECT_ORIGIN` is the real managed HTTPS origin and review the
   optional JSON array `STILLON_CONNECT_MIGRATE_FROM_ORIGINS`. These values are
   public deployment inputs, not credentials; the same account/device authority
   must serve every approved old/new origin. Local/self-hosted manual builds
   remain separate from the required managed configuration of official releases.
3. Update `package.json` to the requested version and refresh `bun.lock` with
   `bun install` when required.
4. Verify the version/tag pair and the code:

   ```bash
   bun run release:verify -- v0.1.1
   bun install --frozen-lockfile
   bun run check
   bun run test
   bun run audit
   ```

5. Commit the version change on `main`, push it, then create and push an
   annotated `v0.1.1` tag.
6. Draft the release title and notes in English from the actual diff, then
   publish the GitHub Release. Keep identifiers, commands and quoted source
   text unchanged when needed for accuracy.
   The `Build release assets` workflow runs on publication, repeats validation,
   uploads export-viewer assets and builds all four unsigned installers/runtime
   archives. It publishes `stillon-release.json` last after all targets pass.
   State explicitly in the notes that beta installers are unsigned.
7. Confirm the workflow passed and that the new release appears in
   **Settings → Changelog**.

### Source-only publication

A release may publish source and export-viewer assets while desktop installers
remain in GitHub Actions for development testing. State that choice in the
public release notes and add the exact marker
`<!-- stillon-release: source-only -->` to the release body. The publication
workflow skips desktop build/upload for that release; source validation and
export-viewer publication still run. Without this marker, desktop publication
builds unsigned beta installers and a complete update manifest. Signed builds
remain an explicitly enabled optional path in
[desktop distribution](desktop-distribution.md).

For a source-only release, run **Desktop installers** manually at the exact
release tag with `require-signing` disabled. Link that run's artifacts in the
notes, label them as unsigned development installers and note their expiration.
Never rename artifacts from an earlier version. Publishing source does not
install or restart a user's running instance.

For enabled managed deployments, request preparation or an upgrade as described
in [managed-updates.md](managed-updates.md); application upgrades keep the
installed controller and updater pinned. For first-time setup or other source
installations, create and validate a new pinned runtime as described in
[production-runtime.md](production-runtime.md), then install the native service
from that runtime. Keep the previous runtime available for rollback.
