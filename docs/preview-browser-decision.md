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

The browser denies downloads, popups, device permissions, service workers and
clipboard access. Inputs, viewport, file sizes, session counts and idle lifetime
are bounded. Closing a view releases its browser session after the idle grace
period; logout and server shutdown close local sessions. Connect revocation
stops image/input delivery at the gateway; abandoned contexts expire locally.
Browser contexts and their storage are ephemeral and never reuse a personal
profile. URL navigation does not migrate arbitrary unsaved application state.

Playwright drives an installed Chromium browser (Edge/Chrome or Playwright's
Chromium); no browser is silently downloaded at runtime. Missing browser support
is a recoverable capability error with retry guidance.
StillOn host, adapter and all other StillOn listeners must remain blocked.

Target-resolution and browser endpoints travel through existing generic Connect
HTTP forwarding, so they do not require a new gateway protocol. Older servers
return an explicit unsupported response. The static project-external HTML
resource repair does require an updated gateway; isolated browser previews do
not depend on that static resource path. Merge does not deploy these changes.
