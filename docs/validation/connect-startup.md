# Connect workspace startup (issue #227)

Connect can show an empty document before its first session indicator, then
replace several loading screens before the composer arrives. This change starts
auth from a small entry, overlaps the remaining code/data work, and keeps one
independent HTML startup surface visible until the route is usable. Preview/file
preparation stays deferred until intent. Browser performance and interaction
acceptance is still pending.

## Startup and resource behavior

- The host and portal HTML contain the same critical CSS and avatar SVG outside
  React. Main styles download as nonblocking print-media links and are activated
  by an independent content-hashed script under the existing `script-src 'self'`
  policy. The document has useful content before the app entry executes.
- A small React/auth entry downloads the workspace module concurrently with
  authentication. HTML preloads discover that required workspace code early;
  it is not a static dependency that auth must await. Static-only chunk groups
  keep auth, workspace and composer code together without pulling in previews.
- After auth, home composer code loads alongside the initial socket snapshots.
  The startup dialog waits for authoritative sidebar/project/settings data and
  committed route/composer components; chat additionally waits for its transcript.
  Saved theme/appearance are applied before reveal. Valid empty workspaces are
  ready states. Optional previews, attachments, discovery and terminals do not
  gate reveal. There is no minimum dwell beyond a 180 ms exit transition.
- Native modal isolation and an inert/hidden root protect startup. Existing auth
  revalidation retains its own native shield after boot. Cancelled navigation or
  session checks fence delayed reveals, including browser page restoration.
  Load failures and prolonged waits retain ordinary reload/navigation links even
  when the app entry fails. No new startup contract is injected into legacy host
  documents; each host continues to serve its own matched HTML and code.
- Authentication mounts the workspace immediately. Project, chat and settings
  subscriptions start together. Only the sidebar waits for authoritative settings,
  so saved collapse/order choices do not flash defaults or get overwritten.
- The portal combines session/host reads. An existing-session authorization page
  attempts authorization directly. Focus checks share in-flight work and account
  changes discard previous host lists.
- Preview routes, file renderers, attachment preview dialogs and optional workspace
  dialogs load on demand. Merely rendering a resource link performs no resolution,
  registration, capability fetch or grant creation.
- File menus immediately show loading, then use a read-only metadata endpoint.
  Activation registers a target and passes its validated metadata to the renderer.
  Native modified/middle/new-tab navigation uses a same-origin resolver page;
  navigation never automatically opens an OS application.
- In-flight work is shared within origin/session epoch/project/target/action.
  Session changes fence late results and clear prepared metadata. File content
  and actions still require current server authorization.
- Unchanged target renewals avoid writes. Concurrent changes share a durable
  atomic flush; failures remain visible and retryable.

`stillon:startup:*` UserTiming marks distinguish authentication, socket opening,
initial subscriptions, preference/data readiness and startup reveal. The reveal
mark records the controller's release, not browser performance acceptance or
successful message submission. Browser acceptance must observe the actual DOM.
`Server-Timing` adds monotonic host, adapter and gateway
durations; these are nested durations and must not be added together as separate
wall-clock stages. No account IDs, paths, URLs or message contents are recorded.

## Build measurements and budgets

Baseline: main `0efdfb439f17e8ac89cb7a5571a320efeb4c098e`, Bun 1.3.14,
production Vite builds on the same Intel macOS machine. Sizes include every static
dependency in the relevant manifest closure, using Brotli where a sidecar exists
and identity for tiny uncompressed files.

| JS closure | Baseline bytes | Candidate bytes |
| --- | ---: | ---: |
| React/auth entry and its static imports | 257,758 | 58,976 |
| Interactive home, including workspace code and composer | 273,670 | 213,858 |
| Chat, transcript and composer | 348,751 | 339,172 |

The independent startup controller adds **1,450 Brotli bytes** (4,268 raw bytes).
Critical HTML/SVG and CSS add 4,446 raw bytes inside HTML. Including the controller,
complete-home JS is 215,308 bytes, about 21.3% below main. Its module closure has
five files, plus that independent controller; this counts build modules, not a
measured browser request waterfall. Workspace code is preloaded concurrently, so
the small auth closure is not a claim that only 58,976 bytes reach the browser
before authentication completes. Preview renderers are absent from the home
closure. The complete-home budget of 200,000 bytes is **not yet met**.
An earlier 209,406-byte browser counter omitted
modulepreload initiators; counting only script initiators or only the entry's
static closure undercounts the interactive home.

Before optimization, ten loopback navigations with cache disabled had observed
project-data-plus-enabled-textarea readiness p50 **1,664.0 ms**, p95 **3,344.8 ms**
(nearest-rank; n=10). This includes browser polling overhead. It does not measure
successful message submission. The proposed local targets remain p50 ≤1,400 ms
and p95 ≤2,400 ms with paired n=20 baseline/candidate runs. Candidate browser
percentiles are unavailable, so no wall-clock speedup is claimed.

## Completed functional checks

An independent authenticated gateway and real frp transport ran on a remote
Hong Kong server, with the adapter/host on the development Mac. Requests reached
the remote gateway through an SSH-forwarded loopback HTTP entry. This exercises
the real WAN gateway → frp → adapter → host path; it is a different ingress from
public production HTTPS. Accounts, mail capture, database and device keys were
synthetic and isolated from production.

Baseline and candidate HTTP/WebSocket checks established:

- Synthetic OTP and PKCE host authorization, initial project/settings/chat
  snapshots, and acknowledged commands.
- Candidate settings saved remotely are read locally; local writes are read
  remotely; an invalid write preserves the saved value.
- Compressed application asset hashes/encoding match the host's bytes.
- Reusing an HTML target preserves a missing-file 404 and recovers without
  registration. HTML and relative ES modules work through the real tunnel; Markdown, text,
  image and non-preview video downloads preserve exact bytes.
- Remote OS actions are denied. Logout invalidates resource grants and new
  authenticated fetches.

An unchanged v0.6.2 host/connector/adapter was also exercised across a gateway-only
upgrade: existing/fresh sessions, enrollment, chats/settings, its own frontend
bytes, legacy previews, lease renewal beyond 54 seconds, logout and a 100 MiB
hash/Range transfer passed.

Build-asset caching requires a generated Vite allowlist and SHA-256 verification
of the exact identity/Brotli/gzip representation. The relay uses **private**
immutable caching only for proven application build assets; APIs, HTML, private
files, grants, cookies, partial responses and unlisted files remain `no-store`.
Old hosts without proofs retain `no-store`. Existing `Connection: close`,
`keepalive: false`, cancellation and streaming/backpressure safeguards remain.
Allowlist identity and representation verification use content, so rapid
same-length replacements on filesystems with coarse timestamps cannot reuse an
older proof.

Regression tests cover scoped request sharing/session fencing/retry, metadata
handoff and action cancellation, registry concurrency/restart/write failures,
build proof mutation/build switching/cache exclusions, and gateway compatibility.
Startup regressions additionally check nonblocking critical HTML, native modal
and inert isolation through the exit transition, stale reveal cancellation,
script/style failure recovery, OTP loading, reduced motion, static-only chunk
reachability, fixture document isolation and built host/Connect controller serving
under the unchanged CSP. The earlier real WAN checks above precede the new
shell/entry revision; managed Connect visual acceptance has not been rerun.
The transport integrity fixture selects a generated leaf ESM from the Vite
manifest, independent of chunk naming. Twenty native cache-busted imports across
cancelled metadata requests remain required; application entry modules are excluded.
Run `bun run check`, then `bun run test`, then `bun run audit`. Avoid rebuilding
the shared `dist` directory while tests serve it.

## Remaining acceptance

- Paired browser n=20 cold/hot, first-login and direct-chat samples, with a
  waterfall counting all JS initiators, actual readable conversation content and
  a usable composer. Do not combine uncalibrated cross-machine timestamps.
- Browser proof that a 200-link conversation makes zero registration/metadata/
  grant/capability requests before intent; delayed/failed metadata does not block
  reading or typing; immediate loading, retry, cancellation and stale-navigation
  behavior work in menus.
- Local and remote action matrix, modifiers/middle click/native new tab, keyboard,
  copied links, standalone reload, image loading and saved sidebar preferences.
- Browser warm-cache behavior across builds, old tabs, logout/revocation and
  account/host changes, including a delayed settings snapshot.
- Reach the declared interactive-home byte and browser latency budgets, or
  explicitly agree revised budgets based on representative measurements.

Real iPhone/iPad Safari has not been tested. No release, production deployment or
installed-host upgrade is part of this change.
