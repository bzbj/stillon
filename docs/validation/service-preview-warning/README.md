# Host service preview warning

When StillOn is visited through a loopback origin, service links in chat and
Markdown, sidebar service rows, address submission and standalone actions open
the original HTTP(S) URL in a browser tab. Historical standalone service targets
redirect to the original URL; a restored sidebar address offers a direct link.
Neither path mounts a screenshot browser. Local file previews keep their native
isolated iframe. LAN and Connect entries retain the remote preview behavior.

Through a remote entry, opening a loopback HTTP(S) service first displays the approved static SVG
warning in the sidebar or standalone viewer. Both title lines have equal size
and weight. The recommended action copies a self-contained local HTML prompt;
if both clipboard paths fail, a selected read-only prompt supports manual copy.

Opening or cancelling confirmation creates no screenshot-browser session and
starts no screenshot polling. Explicit confirmation mounts the existing isolated
browser. Consent is scoped to the current workspace, viewer and service origin:
same-service navigation and toolbar refresh retain it, while another origin,
reopening the viewer or reloading the application require confirmation again.
HTML file previews continue to use their existing isolated native iframe.

The workspace browser acceptance script now checks the warning and cancellation
before continuing its service-list, navigation, standalone, reload and input
matrix. The change was also exercised in the running workspace through loopback
and an authenticated Connect fixture with its real login gateway, frp tunnel,
adapter and host. That acceptance covers clipboard denial/manual copy, keyboard
cancellation, confirmed service navigation, application reload, another port,
localhost/IPv6 aliases, native HTML resources, narrow warning layout and themes.

The confirmation remains a client-side UX choice. Existing host authorization,
network restrictions and session revocation continue to protect the browser API.
