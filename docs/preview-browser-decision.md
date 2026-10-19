# Isolated preview browser decision

Preview documents and web applications share a logical target. Sidebar and
standalone views use the same renderer and authenticated target resolver.
Opaque target IDs identify resources; they never grant access by themselves.

The current client uses the separate headless Chromium only for host loopback
services. The client receives images and sends bounded input over authenticated
HTTP through Connect's gateway, tunnel and adapter. Services keep their own CSP
and frame policies. The #224 IME and pointer protocol fixes remain in this path.

Files instead use native HTML/Markdown/text/image renderers in the visiting
browser. See [file origins](preview-files-v2-design.md). Ordinary external websites
open directly on that device; new external preview registrations and browser
sessions are rejected. Legacy external records provide an explicit opening link.

Each authenticated entry session/workspace has separate service browser contexts.
An explicit service URL grants only its own origin, independently of discovery.
No personal browser profile, StillOn credentials or debugging endpoint is exposed.

Loopback connections also verify the listener's process ID and start time,
independently of cached service discovery. A replacement process cannot inherit
an existing grant; an explicit reopen or refresh authorizes the service again.
Unavailable listener metadata fails closed. Unix hosts need `lsof` (and `ps` on
macOS); Windows uses its native listener and process metadata.

Service-list discovery is separate from admission. Windows probes HTTP metadata
through its system HTTP client, in one hidden PowerShell process per uncached
scan, because Bun's HTTP socket overrides and refused raw connections are
unreliable on that platform. This adds cold process/compiler startup cost, but
preserves the intended address family and bypasses configured egress proxies for
loopback only. Metadata, redirects and scan lifetime remain bounded.

The browser denies downloads, popups, device permissions, service workers and
clipboard access. Inputs, viewport, file sizes, session counts and idle lifetime
are bounded. Closing a view releases its browser session after the idle grace
period; logout and server shutdown close local sessions. Connect revocation
stops image/input delivery at the gateway. Each browser also inherits the signed
parent lease expiry forwarded by the adapter; without authorized renewal, its
context and live network connections close within the 45-second lease limit.
Browser contexts and their storage are ephemeral and never reuse a personal
profile. URL navigation does not migrate arbitrary unsaved application state.

Text is committed once after visiting-device composition. Mouse/touch presses,
movement and releases are ordered across the HTTP transport. Held input belongs
to one viewer and is cancelled on view release/navigation or after five seconds
without foreground pointer renewal. Passive background heartbeats cannot retain
a press. Cancellation does not synthesize a button activation.

Clipboard permissions are denied for each secure navigation origin, and every
frame disables the async clipboard object and legacy copy/cut/paste commands.
Host clipboard shortcuts, including Shift+Delete, are rejected before input.
Acceptance checks permissions and guarded interfaces without reading or writing
the operating system clipboard.

Playwright drives an installed Chromium browser (Edge/Chrome or Playwright's
Chromium); no browser is silently downloaded at runtime. Missing browser support
is a recoverable capability error with retry guidance.
StillOn host, adapter and all other StillOn listeners must remain blocked.

Public IPv6-only plain HTTP is explicitly unsupported and fails closed with
guidance to use HTTPS or IPv4. It must never be forwarded through a localhost
substitution. Authorized loopback IPv6 and HTTPS CONNECT retain their own paths.

Service target-resolution and browser endpoints use generic Connect forwarding.
They require the #224 host/adapter lease support. Direct file rendering separately
requires file-preview protocol 1 in the host, adapter and gateway; missing support
has an explicit upgrade error. Package versions alone do not establish that
capability. Source merge never deploys or upgrades a running instance.
