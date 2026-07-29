# Security audit exceptions

StillOn fails CI and release checks when `bun audit` reports a high- or
critical-severity advisory. Any exception must name one advisory explicitly,
document why the affected code is unreachable, and include a removal
condition.

## GHSA-qwww-vcr4-c8h2 — React Router RSC source disclosure

- Added: 2026-07-29
- Scope: `react-router` 7.12.0 through 8.2.x
- StillOn exposure: none known. The advisory affects React Router's unstable
  RSC APIs. StillOn uses the browser router APIs and does not import the
  affected RSC modules.
- Reason for the exception: the advisory names React Router 8.3.0 as the
  patched release, but that version is not available from npm yet.
- Compensating control: `bun audit` continues to fail on every other high- or
  critical-severity advisory; only `GHSA-qwww-vcr4-c8h2` is ignored.
- Removal condition: remove the exact `--ignore` argument from `package.json`
  and upgrade React Router as soon as a patched release is available from npm.

Reference:
<https://github.com/advisories/GHSA-qwww-vcr4-c8h2>
