# Dynamic web previews

Start an HTTP development server on the computer, then select it or enter its
explicit URL in the Browser panel. The same saved loopback address works locally and through Connect.
**Open standalone** opens the current target in an independent preview page,
using the [isolated browser](workspace-previews.md).

The legacy direct preview transport keeps local loopback URLs. Managed Connect
direct previews open a separate
origin for each computer and port:

    https://p-<computer-id>-<port>.connect.stillon.example

This uses the existing wildcard DNS/certificate and authenticated gateway. The
gateway and computer must both include dynamic-preview support. Shared ingress
rules must route these wildcard names to Connect, preserving the public Host.
No development port is made public on the computer.

## Supported applications

HTTP pages, ES modules, styles/images, same-origin API requests, forms, deep
links, redirects and WebSockets retain their original paths. Vite hot updates
work through the signed tunnel, including the vite-hmr subprotocol.
Application cookies and Authorization headers stay within that preview.

Use same-origin URLs in the application. A hard-coded localhost URL in browser
JavaScript still refers to the visiting device. Put APIs on the same development
origin or configure the development server's own API proxy. HTTPS-only local
servers, separately addressed backend ports and service-worker/offline behavior
are outside this HTTP preview contract.

macOS/Linux listener discovery uses lsof; Windows uses netstat.exe. Windows
shows available page titles without Unix process-directory attribution.
Discovery is a launcher hint, not admission for the current service renderer.
An explicit /app URL works when the root is 404, has no title or is slow. The
current client uses the #224 isolated-browser service compatibility renderer;
file and external links do not enter it. StillOn's own listener, remote adapter
and debugging/control ports remain blocked. Process termination remains a
local action.

## Request flow and isolation

1. The normal computer origin authenticates the Browser-panel handoff.
2. A single-use ticket, valid for 60 seconds, is exchanged on the isolated
   preview origin for a host-only HttpOnly cookie. It grants access to one
   computer/port and is tied to the existing account's parent session.
3. Each HTTP/WebSocket request is checked by the gateway and receives a signed
   lease for the exact method and preview path. frps/frpc routes it to that
   computer's adapter, which validates the lease and the local HTTP service.
4. The adapter forwards to loopback with application credentials only. It
   removes Connect/internal credentials and rebuilds Origin for the local app.
   Streams retain lease renewal, expiry and revocation behavior.

The development app cannot read StillOn cookies, storage or APIs. Its cookies
are constrained to its own preview host; reserved Connect cookies and parent
Domain attributes are removed. Service worker installation is blocked so it
cannot serve cached private pages after revocation. Responses are not cached.

Logout, account revocation, pause and unbind invalidate access and close active
streams. Gateway restart forgets preview sessions; reopen the preview from
StillOn. An unavailable web server displays a recovery message. Static file
previews continue using their separate read-only resource capabilities.

## Validation

    bun run check
    bun run test
    bun run prepare:connect-runtime --server
    bun scripts/test-connect-dynamic-preview.ts

The isolated integration uses two real StillOn servers, a fake mail sender,
real frps/frpc and a real Vite development server. It checks discovery through
the StillOn WebSocket, resources/routes/redirects, local/remote API writes,
application cookies, origin/account boundaries, blocked control ports,
vite-hmr subprotocol/updates, renewal past 45 seconds, pause and logout.
It never starts an Agent or sends email.

For browser QA, add --browser-output=<private-json-path>. The fixture stays
running until SIGINT/SIGTERM. That file contains only generated test-session
credentials and test addresses; keep it outside published artifacts.

## Current UI versus direct forwarding

The ticket/port forwarding described above remains a legacy HTTP transport and
is exercised by `test-connect-dynamic-preview.ts`. The current Browser panel and
standalone service page use `/api/preview-browser` over generic authenticated
Connect forwarding. These are distinct paths; passing the legacy HTTP/HMR fixture
does not establish the whole UI acceptance matrix.

| Capability | Current service renderer | Legacy port forwarding |
| --- | --- | --- |
| Explicit deep URL without root discovery | Supported with service process authorization | Existing discovery-based admission |
| Same-origin HTTP/API/form/WS | Supported | Supported |
| Current navigation and explicit retry without POST replay | Supported | Browser/application behavior |
| HTTPS localhost | Normal certificate validation; self-signed not bypassed | Not in HTTP-only transport contract |
| Hard-coded additional localhost ports | Separate grants/configuration required | Not automatically rewritten |
| Service Worker/offline persistence | Denied | Denied |

Direct HTML/MD/TXT/image files do not use either service engine. Their isolated
file origins and protocol 1 host/adapter/gateway capability are documented in
[the file design](preview-files-v2-design.md). No global certificate, origin or
antivirus bypass is part of these implementations.
