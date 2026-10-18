# Workspace preview validation

Baseline: server/adapter/application 0.6.2, source `0b695e9`. The installed managed
application remains on this baseline. No release, deployment or local upgrade is
part of this PR. The public gateway health endpoint responds but does not report
its source version; that deployed version is **unknown**.

Implementation covers target resolution, shared document views, isolated web
browsing, directory capabilities, independent admission, navigation and recovery.
Implementation/review ownership and the final source revision are tracked in the PR.

## Reproduction and evidence

```sh
bun run check
bun run test
bun run audit
bun run test:previews:browser --local-only --external-sites

# Full authenticated integration, with verified native transport binaries:
bun run prepare:connect-runtime --server
bun scripts/test-connect-dynamic-preview.ts
bun run test:previews:browser
bun run test:previews:browser --firefox
```

Windows local browser: Edge/Chromium 155. Fixtures use synthetic documents,
accounts and machine names, never start an Agent and never send email.
Generated evidence is under `test-artifacts/workspace-previews/`. API assertions
record modules, resources, actual input, storage, exactly-once form submission,
WebSocket echo, deep routes, bidirectional backend writes and blocked control ports.
Browser assertions record sidebar/standalone rendering, relative images, real
button writes, modifier/middle clicks, native context menus and refresh.

Only result summaries and generic screenshots may be uploaded. Private fixture
JSON includes generated test credentials and must remain private.

The Windows type/build checks, audit and focused preview regressions pass.
The full local suite encountered existing `EPERM` failures creating symlinks and
spawning a long encoded PowerShell test. These unchanged tests also fail in a
clean baseline worktree. This is **not** a passing full-suite result. The PR's
full supported-platform CI matrix must pass before merge.

Windows Defender blocks extraction of the checksum-verified official frp test
package here. No security exclusions or policy changes were made. CI runs real
frps/frpc, authenticated gateway, adapter and StillOn hosts on Linux. That is
integration evidence on one test machine, not second-device production acceptance.

## Matrix

Pass means an executed local assertion; Blocked does not mean Pass. The Connect
integration has a separate CI record and cannot replace second-device acceptance.

| Content | Local sidebar | Local standalone | Second-device Connect sidebar | Second-device Connect standalone |
| --- | --- | --- | --- | --- |
| Project Markdown | Pass | Pass | Blocked | Blocked |
| External Markdown | Pass | Pass | Blocked | Blocked |
| Project HTML application | Pass | Pass | Blocked | Blocked |
| External HTML application | Pass | Pass | Blocked | Blocked |
| Host HTTP application | Pass | Pass | Blocked | Blocked |
| External HTTPS content | Pass | Pass | Blocked | Blocked |
| XFO-restricted content | Pass (controlled app) | Pass | Blocked | Blocked |
| CSP-restricted content | Pass (controlled app) | Pass | Blocked | Blocked |
| External HTTP content | Pass | Pass | Blocked | Blocked |

The controlled app sets both `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. Its actual sidebar button/form still writes to the
backend: it is rendered in a browser rather than a third-party iframe.
Public HTTPS and HTTP samples are optional network-dependent smoke checks.

## Plan checklist ledger

These statuses describe local/automated evidence. Production-gateway and
second-device portions remain blocked pending authorized test access.

| IDs | Evidence or remaining gate |
| --- | --- |
| A01 | Chat document/HTTP routing, real sidebar API button write |
| A02 | Shared renderer and Markdown/address checks; file-tree/service-list manual coverage pending |
| A03 | Modifier/middle click and native-context-menu checks |
| A04 | Workspace/history isolation regressions; multi-device exercise pending |
| A05–A06 | Markdown formatting, relative images/documents, anchors and shared renderer |
| A07 | Direct access/reload and persisted opaque registry restart regression; production re-login pending |
| A08 | Classic/module scripts, CSS, image/font, JSON fetch, actual counter button |
| A09 | Blocked: external HTML through the deployed production Connect version |
| A10 | Bounded file-app storage/fetch and real HTTP backend writes; no implicit backend execution |
| A11–A12 | Titleless, root 404 and 900 ms root variants admit the actual application path |
| A13–A14 | IPv4/IPv6/encoding/query/fragment regressions and localhost listener fallback |
| A15 | Actual API, native form, WebSocket echo; refresh does not replay POST |
| A16 | Resource/redirect policy regressions and transport integration; production check pending |
| A17 | Gap: arbitrary absolute localhost URLs and multi-port backends are not automatically remapped |
| A18–A19 | Current deep path/query/fragment and SPA replace/pop store checks; production navigation pending |
| A20 | Active-session storage, standalone reuse and reload; expiry/reclamation is documented |
| A21 | Local backend writes/reads; cross-entry writes in Connect CI, final remote acceptance pending |
| A22 | Blocked: second-device wrong-host marker was not supplied |
| A23–A25 | Stopped service restart retains the deep target and recovers immediately; 401/403/500 remain app responses; production offline rehearsal pending |
| A26 | Controlled framing restrictions and public-site smoke; remote HTTP-only device check pending |
| A27 | Session reuse, viewer release, quotas and cleanup; prolonged lifecycle review remains separate |
| S01–S02 | Owner-bound IDs and account/host gateway regressions; production multi-device check pending |
| S03 | Directory/hidden-file/escaping-link checks; Windows link privilege limits the local suite |
| S04–S05 | Unsafe protocols, credentials, private/mapped IPs, control ports, header stripping and host clipboard denial |
| S06 | Gateway resource revocation and transport logout/pause CI; production browser-session check pending |
| S07 | Connection origin/address/blocked-port checks; arbitrary process-identity pinning is not implemented |
| C01 | Existing store migration retained, targets persist, expired IDs show recovery guidance |
| C02 | Generic HTTP forwarding retained; old adapter session headers fail closed; deployed version combinations pending |

## Deployment and outstanding acceptance

Update the gateway for legacy project-external static capabilities, then deploy
the host/adapter/client through normal managed releases. The host needs installed
Chromium. Roll back with existing managed recovery; do not edit ownership metadata.

Final acceptance is **not complete** until an authorized second device checks the
candidate through the real login gateway, tunnel, adapter and host, including the
wrong-host marker, persistence, revocation, offline recovery and version matrix.
PR merge is independent from acceptance, release and local upgrade.

![Independent Markdown reading page](../images/workspace-preview-standalone.png)
![Dynamic application after a real sidebar button write](../images/workspace-preview-dynamic.png)
![Project-external HTML modules, resources and stored counter](../images/workspace-preview-html.jpg)
