# Releasing StillOn

StillOn is released from GitHub source. It does not publish an npm package and
does not perform in-app self-updates. A GitHub Release is the source for the
in-app changelog. When **Settings → Changelog** sees a newer stable release,
it only generates a copyable source-upgrade prompt for Codex or Claude Code;
it never runs an installation, restart, or package-manager command itself.

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

## Release procedure

1. Work from a clean, up-to-date `main` checkout. Do not release from a
   feature branch or a worktree containing unrelated changes.
2. Review commits since the latest tag and confirm the requested version.
3. Update `package.json` to the requested version and refresh `bun.lock` with
   `bun install` when required.
4. Verify the version/tag pair and the code:

   ```bash
   bun run release:verify -- v0.1.1
   bun install --frozen-lockfile
   bun run check
   bun test --timeout 20000
   bun run audit
   ```

5. Commit the version change on `main`, push it, then create and push an
   annotated `v0.1.1` tag.
6. Draft release notes from the actual diff, then publish the GitHub Release.
   The `Build release assets` workflow runs on publication, repeats the
   validation, and uploads the export-viewer assets.
7. Confirm the workflow passed and that the new release appears in
   **Settings → Changelog**.

For deployments, upgrade by creating and validating a new pinned runtime as
described in [production-runtime.md](production-runtime.md), then reinstall
the native service from that runtime. Keep the previous runtime available for
rollback.
