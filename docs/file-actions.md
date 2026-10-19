# File and service actions

Normal external HTTP(S) links open on the visiting device, including links ending
in `.html`, `.md` or an image extension. They retain the browser context menu and
never register a StillOn preview target.

| Resource | Loopback entry | Authenticated Connect workspace |
| --- | --- | --- |
| Previewable file, including images | Click: sidebar; menu: Preview, Open, Show | Click: sidebar; menu: Preview, Download |
| Other file, including DOCX/PPTX | Click: default application; menu: Open, Show | Click and menu: Download |
| Host loopback HTTP(S) service | Click: sidebar; menu: Preview, Open | Click and menu: Preview |

The menu order is Preview in sidebar, Open on this computer, Download, Show in
Finder/folder. Hidden items leave no space. Local file controls hide Download.
Explicit Open always opens the original file or service URL; Show reveals the
original file. The server rejects host actions from Connect and other remote
ingress, including forged local flags. The host platform determines Finder/folder.

Chat, Markdown body links and service controls use shared target
classification and action policy. Registering a standalone href never removes a
file/service menu. Shift+F10 and the menu key open it; Escape closes it.

Modifier/middle clicks on previewable resources open an authenticated standalone
page. They never dispatch a local application action for unsupported files.
Remote downloads return original bytes and a UTF-8 filename after checking the
response; an authentication/error page is not saved as the document.

Existing attachment cards and Markdown inline images keep their existing display.
Image path links additionally support sidebar/standalone preview. File URL and
home paths name the StillOn host, never the visiting device. Text not converted
into a link is outside this link-handling change.
