# Workspace previews

Files render directly in the visiting browser. Markdown uses the shared renderer,
text/code uses escaped text, images use AttachmentImage, and HTML uses a real DOM
on an isolated file origin. None of these paths starts Chromium on the host or
polls screenshots. Frontend-only HTML does not require a development server.

The toolbar opens the current logical target in an independent authenticated
`/preview/<id>` page. IDs persist for 30 days; every file read rechecks the owner,
workspace, canonical path and access. The standalone page can reload without its
chat mounted. Query/fragment and document navigation remain logical URLs rather
than short-lived resource grants.

## Renderers

The [complete extension inventory](file-preview-types.md) is generated from the
allowlists. The authoritative registry is `src/shared/file-renderers.ts`, using the existing
text/code allowlist in `project-file-urls.ts`:

| Extensions/types | Renderer |
| --- | --- |
| HTML, HTM | Isolated HTML document |
| MD, MARKDOWN, MDOWN | Markdown with tables, code, anchors, images and shared link actions |
| TXT, JSON/JSONC, JS/TS/JSX/TSX/MJS, CSS/SCSS, Vue, Python, Rust, Go, Java/Kotlin, C/C++/C#/headers, Swift, Ruby, PHP, Perl, Lua, shell, SQL, GraphQL, TOML, YAML, XML, configuration/log/diff/patch/property files | Escaped text |
| .gitignore, .npmrc, .prettierrc, Dockerfile, Makefile, Gemfile, Procfile | Escaped text |
| PNG, JPG/JPEG, WebP, GIF, SVG, AVIF, APNG, BMP, ICO | Native image; browser decoding applies |
| DOCX, PPTX, PDF, PSD/RAW and other unregistered path types | No new renderer; local default app or authenticated remote download |

Existing attachment-specific media/image/document behavior remains available;
this table describes file path links, not a replacement attachment classifier.
SVG loads as an image, never as HTML inserted in the app. Images keep aspect ratio,
transparency and animation. Zoom and long-image scrolling use the same panel in
both views. Resources/images are limited to 25 MB; image display is limited to
40 megapixels after native decoding. This is a display check, not a decoder memory
sandbox. Text previews reject content over 1 MB rather than execute or silently
show it as a complete file. Refresh rereads disk; image failures offer retry.

## HTML isolation and resources

See [the implementation design](preview-files-v2-design.md). HTML can load local
classic/module scripts, CSS, images, fonts and static JSON from its authorized
document directory and descendants. Root-relative URLs map to that same directory.
Parent/hidden paths and escaping symlinks/junctions are denied. The origin is stable
during the live grant and does not change on resize. HTML has native selection,
input, IME, pointer events, storage, Canvas and frontend animation.

File resources are read only. Backend writes, databases, CDN/third-party API
requests and multiple localhost dependencies are not automatically supported.
Start the app's backend separately and open its service URL. There is no automatic
fallback to screenshots when a file dependency is unavailable.

## Services and external sites

Host loopback services retain the isolated-browser compatibility path, with the
input/drag fixes from #224. Only this path needs host Chrome/Edge/Playwright.
Explicit deep URLs do not require discovery, a title or a successful root page.
Service discovery keeps the native Windows dual-address-family probe.

Services retain same-origin API, forms, WebSocket, path/query/fragment and retries
without replaying a business POST. Private/control/debug ports and service-process
replacement remain guarded. Backend data, not localStorage, is shared across
entries. HTTPS localhost certificate trust, multiple ports and Service Workers
have the limits documented in [the browser decision](preview-browser-decision.md).

External websites open in the visiting browser. Historical external preview
records show an explicit browser-opening link and never auto-open repeated tabs.
Old Markdown, HTML and service target IDs are retained and reauthorized.

## Other authenticated proxy ingress

HTML origins in this implementation support loopback and managed Connect. A
custom authenticated reverse proxy without a separate preview hostname receives
an explicit isolated-origin/upgrade error instead of a visiting-device localhost
URL or an automatic screenshot fallback. Markdown/text/images and original file
transfer keep their authenticated main-origin paths. Such proxy HTML requires
its own origin integration; merging source does not change existing proxy routing.

An HTML document cannot directly request host application launches through
postMessage. Links to unsupported files or host services present an explicit
trusted-parent action. Regular StillOn chat/Markdown/Git/service links retain the
B01–B08 default actions. File navigation reports cannot supply arbitrary URL
suffixes or turn the parent into a management API client.
