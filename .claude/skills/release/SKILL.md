---
name: release
description: Prepare and publish a source release for StillOn.
---

# StillOn release

StillOn is currently distributed as a source-available GitHub beta. Do not publish the npm package while package.json remains private.

## 1. Verify

~~~bash
git status --short
bun install --frozen-lockfile
bun run check
bun test --timeout 20000
bun run audit
~~~

Stop if the worktree is dirty for reasons outside the release, any check fails, or a high-severity audit finding remains.

## 2. Select a version

Review commits since the latest tag and choose semantic-versioning scope:

- patch: fixes and small polish;
- minor: backward-compatible features;
- major: breaking behavior or data changes.

Confirm major versions with the user. Update package.json and bun.lock together.

## 3. Create the tag and release

Commit the version change, push main, then create and push an annotated vX.Y.Z tag. Draft release notes from the actual diff, covering user impact, security changes, platform support, migration, and validation.

Create the GitHub release with gh release create. Publishing the release triggers .github/workflows/publish.yml, which verifies the tag, runs checks, and attaches export-viewer assets.

## 4. Verify publication

Confirm the workflow passed, assets are downloadable, checksums match when provided, and the in-app changelog can read the new GitHub release.
