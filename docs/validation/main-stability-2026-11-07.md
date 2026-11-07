# Main stability validation — 2026-11-07

Scope: P0 update/recovery reliability and P1 statistics, paired Local/Connect
behavior, attachment recovery and workspace previews. Baseline public main:
`d6b9c834b15dba2f1bc6ad4d813c014794e31fb0`. Private gateway baseline:
`41bdd5606c7767618f5bd15363d209727f17c26c`. Private integration uses an isolated
worktree with the proposed public client, synthetic accounts and data, a test
login sender, the actual gateway, native frps/frpc, adapter and StillOn server.
It does not deploy the gateway or send real login email.

## Fixes and added checks

- Wait for launchd to remove an unloaded updater registration before bootstrap.
  Existing application service installation already performed this wait; worker
  replacement did not. A successful `bootout` does not mean removal has finished.
  The wait is bounded and inspection errors prevent registration. Failed initial
  inspection also preserves an existing worker definition.
- Align the documented and package-declared Bun minimum with the CI runtime,
  1.3.14. Bun 1.3.5 lacks `Bun.Archive`, which the runtime/component archive
  paths require. The old runtime failed archive tests; it is not a passing
  supported-runtime validation.
- Retry only `Page.captureScreenshot`'s transient missing-surface error, at most
  twice within the existing capture deadline. Never repeat the input that
  preceded capture. Persistent failure remains a retryable frame failure; closed
  targets and unrelated protocol errors retain their failure behavior.
- Extend the statistics benchmark with process CPU time, sampled process memory,
  p95 transcript append time and statistics-drain time.
- Exercise statistics opt-in saves and reciprocal reloads through both entries,
  plus a write failure that preserves the confirmed preference and permits retry.
- Use the native Finder label in macOS browser menu acceptance. The previous
  hard-coded Windows/Linux label rejected correct macOS behavior.

## Validation results

| Check | Result | Evidence |
| --- | --- | --- |
| Type check and production builds | Pass | `test-artifacts/main-stability/check-final.log` |
| macOS native worker lifecycle | Pass, Apple Silicon | Unique temporary launchd label; startup, replacement, injected registration failure, retry, history retention and cleanup |
| Existing service/updater regressions | 124 pass, 3 Windows-specific skips | `test-artifacts/main-stability/p0-tests.log` |
| Statistics/upload/preview focused regressions | 44 pass; restart boundary added separately | `test-artifacts/main-stability/p1-tests.log` |
| Added registration and capture regressions | 7 pass | Simulated asynchronous removal, native failure diagnostics, bounded frame recovery and input applied once |
| Upload crash/restart boundary | Pass | In-memory state reconstruction rejects stale offsets, retains complete files, expires orphan staging and permits a fresh complete upload |
| Remote auth/image recovery browser | Pass, Chromium and Firefox | Bounded observable focus, authentication refresh, draft/scroll retention, attachment retry and unmount cleanup |
| Statistics component browser | Pass at 375 and 1440 CSS px | `test-artifacts/main-stability/statistics-browser.log` |
| Settings Local + Connect browser | Pass | `test-artifacts/settings/connect/results.json`; includes debug switch and write failure |
| Connect managed-update integration | Pass | Two accounts/hosts; remote upgrade denied; startup, rollback and retry errors retained across reconnect and recovery |
| Connect transport and large-message integration | Pass | Real authenticated tunnel, 20/100 MiB transfer, lease renewal, >5 MiB Unicode history/tool details, bidirectional persisted commands executed once, partial disconnect cleanup |
| Connect upload integration | Pass | 1 byte, 373 KiB, 20 MiB and 100 MiB; replayed accepted chunks/final receipts; exact SHA-256 cross-entry reads; auth/origin/workspace/owner isolation |
| Connect sharing and upload revocation | Pass | Guest uploads retain exact bytes; revoked guests cannot continue unfinished uploads; peers and other workspaces remain available |
| Connect dynamic preview integration | Pass | Vite modules, deep routes, redirects, app cookies, API writes, HMR and renewed WebSocket lease across 54 seconds; pause/logout revocation |
| Local preview API matrix | Pass | `test-artifacts/main-stability/debug-preview.log`; diagnostic wrapper only observes synthetic browser failures |
| Chromium/Firefox paired browser matrix | Pass, 86 checks per engine | `test-artifacts/main-stability/previews-*-final.log` |
| Full repository suite with Bun 1.3.14 | 1,684 pass, 10 conditional skips, 0 failures | `test-artifacts/main-stability/full-tests-final.log` |
| Dependency audit | Pass | Existing repository advisory exception retained |

Initial runs installed missing dependencies and browser binaries. Integration
was repeated with Bun 1.3.14, matching private-repository requirements and CI.
An initial discovery attempt missed the Vite listener under concurrent test
load; its cause is not established. Five fresh IPv4/IPv6 scans and a subsequent
full dynamic integration passed.
The browser suite also exposed the capture failure and the macOS label mismatch
above; those failures are retained in ignored diagnostic logs.

The statistics benchmark is synthetic, without provider calls or network
latency. Alternating on/off rounds share a process, so sampled RSS/heap include
previous allocations. Coalesced bytes per turn depend on run duration. These
numbers must not be interpreted as real-model throughput or first-token latency.

The full-suite result combines 1,676 passing tests across 212 files with the
separate eight-test terminal suite. The first phase took 210.97 seconds. Optional
paid-provider title tests were not enabled. Native fixtures use disposable data.

A first PR CI attempt exposed a one-shot Firefox focus assertion and Windows
listener/fixture-startup failures. The focus assertion now waits for observable
focus and checks it again after the held authentication refresh. Both browser
engines passed the revised authentication and image-recovery suite locally.
On code commit `2a9d8ca1c625055092599cd6c86581f74a3a103e`, the subsequent
Windows x64 job passed the full suite, CLI lifecycle, native updater recovery and
audit. Windows ARM64 passed its full suite and CLI lifecycle; its native recovery
step was still running at this record's cutoff. The first Windows discovery and
fixture-startup failure was not reproduced and its cause remains unresolved;
the initial failure is not erased by the later successful run.

CI on that code commit also passed Ubuntu validation, Mac Intel validation,
settings/statistics browsers, Chromium/Firefox workspace browsers, Windows
workspace preview checks, both authentication browser engines and CodeQL.
Hosted Mac ARM64 jobs were still queued; the native Apple Silicon and full-suite
results above were performed locally. Full run: [CI 42275955575](https://github.com/bzbj/stillon/actions/runs/42275955575).

All production changes are present in `a53edab78c924c15a99ddede543b9b3fa8570fca`;
`2a9d8ca` adds acceptance tests only. The Chromium browser artifact records
`6080b5a`; Firefox records `a53edab`. Browser/client/capture implementation is
identical across those revisions; the later production change is the separately
validated updater-inspection preservation fix. Firefox's dirty flag includes the
untracked report and evolving acceptance tests. Use the independent private
revision at the top of this record for gateway provenance: the existing public
fixture's `gatewayVersion` artifact field repeats the public source ref and does
not establish the private gateway revision.

## Illustrative synthetic statistics result

Five alternating rounds of 100 turns, each with 1,000 synthetic deltas, on the
local Apple Silicon host with Bun 1.3.14 produced these medians:

| Metric per synthetic turn | Disabled | Enabled |
| --- | --- | --- |
| Wall time | 1.283 ms | 1.783 ms |
| Process CPU time | 0.661 ms | 0.775 ms |
| p95 assistant-transcript append duration (median across rounds) | 0.667 ms | 0.642 ms |

Sampled process RSS ranges were 59.9–74.7 MiB disabled and 66.1–74.7 MiB enabled.
They are shared-process samples, not attributable per-session memory overhead.
The negative append-duration difference is noise, not evidence of a speedup.
These illustrative figures are not a performance guarantee or a real-model TPS
measurement. Raw results: `test-artifacts/main-stability/statistics-benchmark-final.json`.

## Remaining acceptance boundaries

- Native macOS rehearsal covers worker registration and retry. Process-level
  updater tests cover interruption, history rollback and orphan cleanup; actual
  logout/login, reboot and power loss are not certified here.
- No new physical Windows x64/ARM64 test was performed on this Mac. Existing CI
  and the Windows native rehearsal remain the corresponding evidence.
- Real paid-provider long-response throughput and physical-device weak-network
  tests are separate from deterministic statistics and transport fixtures.
- Upload receipts/staging remain intentionally non-durable across host restart;
  browser reload/chat change still requires reselecting the original file.
- Safari local HTML preview remains the documented known limitation (#257).
- A production installation update is tracked separately from these isolated
  tests; a prepared candidate or an idle-wait task is not an installed update.

## Follow-up: native pointer targeting in CI

The documentation-head CI run exposed a failure before the first native HTML
click: the iframe rendered successfully, but the `:hover` precondition never
settled. See [the failing Linux job](https://github.com/bzbj/stillon/actions/runs/42277303661/job/128096836622).
The unobstructed case did not reproduce on the local Mac. A new isolated
cross-origin iframe fixture did reproduce a flaw in that precondition: `:hover`
could remain true beneath a transparent parent overlay, allowing the helper to
proceed instead of reporting occlusion. This is not a claim that the original
Linux failure has the same exact timing sequence.

Pointer preparation now activates the visiting tab, re-enters from outside the
frame after layout changes, and requires all three observations: parent hit test
selects the iframe, child hit test selects the target, and a trusted native
`pointermove` reaches that target. CSS hover state alone is no longer evidence
of successful targeting. The five-second bound remains, and only pointer motion
is retried; a click or drag is dispatched once. Timeout diagnostics retain the
measured geometry, focus state and hit-test results.

`bun run test:previews:pointer` and its `--firefox` variant exercise four zoom
levels, foreground/background tab transitions, frame displacement, persistent
occlusion without a click, and successful recovery after removing the overlay.
The fixture uses Node HTTP servers and real browser input without application
accounts, private fixtures or user data. Linux CI runs both engines; Windows CI
runs Edge before the complete preview matrix.

The subsequent Linux run passed the new isolated pointer fixtures but reproduced
the complete-page failure. Its diagnostics showed parent/child DOM hit tests
selecting the iframe/button while the trusted pointer event reached the heading
above it. The actual component layout fixture then deterministically reproduced
a 45 CSS px upward move and height increase when the loading notice disappeared.

Loading, dependency and linked-action notices now overlay a fixed iframe viewport
instead of consuming its flex height. The real-component fixture fails the
geometry invariant before this change and passes with Chromium and Firefox after
it, including native clicks. Complete preview recovery additionally checks
identical frame bounds while loading, slow, unavailable and restored. Both the
real-component geometry fixture and pointer fixture run before complete preview
acceptance in Linux/Windows CI.
