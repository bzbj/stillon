# Isolated preview browser decision

Preview documents and web applications share a logical target. Sidebar and
standalone views use the same renderer and authenticated target resolver.
Opaque target IDs identify resources; they never grant access by themselves.

Websites that deny framing are rendered by a separate, headless Chromium on
the StillOn computer. The client receives images and sends bounded input over
authenticated HTTP, through the existing Connect gateway, tunnel and adapter.
Third-party CSP and frame policies remain intact. No application credentials,
user browser profile or browser debugging port are exposed to the preview.

Each authenticated entry session and workspace gets separate browser contexts.
An explicit loopback target grants only its own service port. External targets
cannot navigate or fetch loopback or private network services. HTML documents
use a private virtual HTTP origin whose read-only files are restricted to the
authorized document directory, including canonical symlink/junction checks.
They can use modules, storage and same-origin static fetches without gaining
StillOn API access or starting backend code.

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

Target-resolution and browser endpoints travel through existing generic Connect
HTTP forwarding, so they do not require a new gateway protocol. Older servers
return an explicit unsupported response. The static project-external HTML
resource repair does require an updated gateway; isolated browser previews do
not depend on that static resource path. Merge does not deploy these changes.
