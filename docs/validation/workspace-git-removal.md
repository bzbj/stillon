# Workspace Git management removal

StillOn no longer manages workspace repositories. Opening a chat does not scan
Git status, enumerate untracked files, read Git baselines, or subscribe to Git
snapshots. The Git panel, its shortcut, polling and terminal-command hooks,
repository-management commands, diff service, commit-message generator, and
Git-only protocol types are removed. The unused `@pierre/diffs` dependency is
removed as well.

File links, document/HTML previews, browser navigation, terminals and conversation
forks remain independent. StillOn's own source installation/updater retains the
Git operations it needs. The provider option allowing ordinary non-Git working
directories is also retained.

## Migration and retired requests

Right-sidebar browser storage moves from version 7 to 8. Retired Git and older
generic drawers become hidden; browser navigation and current pixel widths are
preserved. Older percentage widths retain their existing default-width migration.
Git-only selections and commit drafts are no longer loaded. The retired shortcut
is ignored when reading an existing keybindings file, without discarding other
custom bindings.

Retired socket commands and subscriptions receive ordinary unsupported-request
errors. They are not registered, do not access a workspace, and do not prevent a
subsequent ping. No compatibility handler continues repository scanning or writes.

## Verification

- `bun run check`, `bun run test`: 1,395 passed, 7 skipped, 0 failed.
- `bun run audit` and `bun install --frozen-lockfile --ignore-scripts` passed.
- Targeted post-migration checks: 53 tests passed across router, keybindings and
  sidebar state.
- Local and authenticated managed browser acceptance used a real Git-initialized
  synthetic workspace with 9,200 untracked documents. The managed path exercised
  synthetic OTP/enrollment/authorization, the gateway, frps/frpc, adapter and
  candidate host.
- Opening, reloading and scrolling the chat produced no Git subscriptions,
  commands or snapshot HTTP requests in either entry. Instrumented host Git
  subprocess calls during workspace interactions remained zero. The largest
  observed managed socket frame was 13,827 bytes.
- HTML preview rendered through both entries. Version-7 local browser state
  migrated to a hidden drawer while retaining a 560-pixel width and browser
  history; reopening preview worked.
- A local conversation fork retained its transcript and was readable through
  Connect. No provider turn was submitted in that browser check; existing provider
  fork tests remain in the full suite.
- Restarting the real tunnel preserved the remote document, draft, sidebar option
  button and open menu. The startup dialog stayed hidden through reconnection.

A matched production client build before removal contained 1,038 files totaling
17,681,591 bytes; the removal build contained 127 files totaling about 4.05 MB.
These totals include lazy assets and are not a first-page download measurement
or a measured startup-time speedup.

Hosted source, its pinned public dependency, installed instances and production
gateway were not changed by this validation.

