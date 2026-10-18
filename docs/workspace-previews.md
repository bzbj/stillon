# Workspace previews

Open documents and HTTP(S) links in the Browser panel. **Open standalone** opens
the current target in an independent reading page. Markdown retains formatting,
relative images and links in either view. Modified and middle clicks use
authenticated, opaque preview URLs rather than a visitor's localhost address.

Target IDs persist for 30 days and require account authorization on every read.
They identify resources; knowing an ID does not grant access. Deleted files and
expired permissions produce a recovery message.

## Interactive applications and websites

HTML applications and websites run in isolated Chromium on the StillOn computer.
Install Chrome, Edge or Playwright Chromium there; no browser downloads happen
automatically. Operators may set `STILLON_PREVIEW_BROWSER` to its executable.

Local and Connect viewers use the same component. Paths, queries, fragments,
forms, cookies, storage and WebSockets retain application behavior. Websites
with frame restrictions and HTTP content render in the isolated browser without
removing their security policies. Images and input use authenticated Connect HTTP
forwarding through the gateway, tunnel and adapter.

Each account session/workspace has separate contexts. Sidebar and standalone
views of an application reuse a session. Each frame/input uses the requesting
view's viewport. Contexts expire after three minutes without an authorized viewer;
there are at most eight per server and four per entry session. Closed, inactive
contexts may be reclaimed to make room. Browser storage is ephemeral: use the
application backend for durable data or sharing across local and Connect entries.

HTML files have a virtual HTTP origin restricted to their document folder.
Classic/module scripts, CSS, images, fonts, storage and static JSON fetches work.
Hidden files, traversal, escaping symlinks/junctions, unsupported extensions and
resources over 25 MB are denied. File previews never execute backend code. Run an
HTTP application for backend API writes and server-side routes.

An explicit loopback URL grants one service origin. StillOn, adapter and private
debugging listeners remain blocked. External sites cannot access private networks.
DNS results are checked and TCP connections are pinned, including through the
service's existing HTTP(S) egress proxy. Applications receive no StillOn credentials
or personal browser profile. Service workers, device permissions, downloads,
popups, peer transports and host clipboard shortcuts are unavailable. Paste uses
the visiting device's input. Self-signed certificates and separately addressed
backends require a supported configuration; no global certificate/origin bypass
is installed. Normal third-party website and network restrictions still apply.

## Static compatibility URLs

Existing HTML resource URLs retain an opaque, read-only sandbox. Folder
capabilities allow relative/root-relative assets without app API access. Local
logout clears them; Connect capabilities stop on logout, pause and unlink.
The project-external static-resource repair requires an updated gateway.
Interactive browser previews use generic Connect forwarding and an updated host
and adapter. An older adapter fails closed with an upgrade message.

See [the browser decision](preview-browser-decision.md),
[validation record](validation/workspace-previews.md) and
[dynamic preview transport](connect-dynamic-previews.md).
