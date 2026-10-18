# File preview v2 implementation design

Baseline: `bc0adcec3a02d72d3ae465c1b820f8e32a63faf6` (#224).
The 2026-10-19 link/preview v2 handoff, including its image addendum, supersedes
older requirements for external website previews and local Download menus.
Handoff SHA-256: `65acb8991372d5f73076f34d9f58fffc734a6053c0dd5f6f0c4b554c9ad90820`.
Source merge does not authorize release, installation or a managed-runtime update.

## Contracts and ownership

`resolveLinkTarget` classifies the actual href before suffix inspection. The shared
`fileRenderer` registry and `getLinkActions` implement B01–B08 independently of async
standalone registration. Local capability comes from server ingress, not browser OS
or a caller-supplied local flag. System action endpoints recheck it server-side.
Paths support host drive/UNC, Unix, file URI and home aliases. Chat relative paths
use the workspace; Markdown relative paths use its document directory. URL paths
are decoded once at their boundary; location and code-line metadata stay separate.

Project files remain inside their canonical workspace. Project-external explicit
file resolution reuses the authenticated host-file authority previously used for
external Markdown/HTML; unauthenticated external ingress is denied. A resolution
registers one canonical file, bound to its owner, with an opaque 30-day logical ID.
TXT/Office/image access grants no directory. Only HTML authorizes its canonical
containing directory, with a resource type allowlist and 25 MB limit. Reads repeat
canonical path checks; a replacement symlink cannot silently inherit an old grant.
This is a host-file management capability for an authenticated owner, not a public
absolute-path download endpoint. File target IDs are never bearer credentials.

## Direct HTML origins

Local: a separate loopback listener accepts only unpredictable
`f-<192-bit-live-grant>.localhost` hostnames. Each live grant names an owner,
canonical directory, app parent origin, authentication validity callback and one-hour
expiry. Unknown authorities and other resources fail closed. App cookies are
host-only (`stillon_session` has no Domain attribute); the preview hostname differs
from localhost, 127.0.0.1 and ::1. No app credentials are forwarded to it. Storage is
separate by scheme/hostname/port. The hostname grant is ephemeral and revocable,
not the durable standalone ID. Local logout clears grants. Same-owner/directory
opens reuse the live origin; resize does not navigate or clear storage.

Connect: protocol 1 registers a live parent-session-bound file grant at
`f-<host-id>-<96-bit-grant>.<account-origin>`. The label fits wildcard DNS/TLS and the
63-character label limit. App/account cookies are host-only; HTTPS cookies use the
__Host- prefix. File requests forward no visiting cookie/Authorization header.
A canonical-directory scope key keeps the origin stable for other documents,
query strings and fragments in that directory during the grant. Gateway grant
validity is checked on every request against the account parent,
selected host, pause/unbind state and one-hour expiry. The gateway signs the exact
resource path; tunnel -> adapter -> host checks the owner and file target again.
Active Connect streams are revoked by the existing one-second relay validity check.
The live file hostname is a short-lived folder capability tied to that parent,
not a permanent public URL. It must not be logged, shared or persisted as a bookmark.

The adapter advertises `X-StillOn-File-Preview-Transport: 1`. The gateway transforms
the authenticated entry descriptor only with that capability. A new host behind an
old gateway returns no isolated URL and the client gives an upgrade message. An
old adapter produces an explicit 409. Protocol 1 requires host, adapter and gateway
from this implementation or newer, independent of their package version strings.
The generic signed lease protocol is unchanged.

HTML iframe permits scripts and same-origin only on these separate origins. CSP
permits self-hosted scripts/styles/fonts/media/static fetch, denies app/network
APIs, workers, nested frames and objects, and restricts its embedding parent.
The child cannot read parent DOM/storage. Resources do not set application cookies.
Links report only source-window/origin-checked paths within the authorized directory;
buttons, pointer/input controls and application-handled events remain native.
Location fields are validated separately to prevent query/fragment fields from
becoming path traversal. An authenticated link-resolution endpoint rechecks both
canonical paths against the original HTML directory before the parent registers
another target; lexical paths alone cannot authorize a junction outside it.
Validated HTML descendants inherit that existing directory mapping. Their opaque
targets retain the canonical root across standalone/reload and registry restart,
so a nested page's root-relative CSS/module/JSON still uses the original package.
Client JSON cannot nominate a resource root. Reauthorization keeps a previously
authorized enclosing root and checks that the root itself has not become a
different symlink/junction target; project roots remain confined to the workspace.
Unsupported-file/system actions and host-service grants originating inside HTML
require a visible action in the trusted parent UI; forged child messages cannot
launch a default application. Regular authored StillOn links use normal B01–B08
activation, with no extra prompt.
The parent reauthorizes document links and stores their logical location.
For modifier/middle clicks, the child reserves a tab during its native gesture
and clears its opener. A transferred MessageChannel receives only the resulting
authenticated standalone URL after parent-side containment/authorization. This
does not depend on cross-origin gesture propagation to the parent; missing popup
permission gives a visible error. Host execution still needs the trusted UI.

## Engines and boundaries

Files never depend on the server screenshot/input engine. Ordinary external sites
never register preview sessions. The #224 Chromium engine remains a service-only
compatibility renderer; its IME, pointer ownership/watchdog, lease and discovery
regressions stay covered. No production service startup or ownership metadata is
changed by development/testing.

## Acceptance status

A build or local fixture is not a second device. Record local browser, authenticated
same-host gateway/tunnel integration, physical OS actions and second-device results
separately in the validation report. The 36-cell matrix and 22 menu/source groups
must not be declared complete from pure policy tests. Real OS IME, Finder/Explorer,
mobile downloads, certificate variants and production Connect revisions require
explicit evidence. Package version 0.6.2 alone does not identify a tested build.
