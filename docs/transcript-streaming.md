# Transcript streaming and performance baseline

Chat subscriptions can request `streamVersion: 1` with a fresh `streamId`.
The server sends the usual initial chat snapshot plus a stream stamp, then
`chat-delta` frames containing a base revision, next revision, changed metadata,
entry upserts and, when membership/order changes, the complete recent-window ID
order. Missing IDs in that order are removed from the recent window; the existing
pagination reconciler retains entries that slide into already-loaded history.
Same-ID replacements are compared by content and replace the entry object.

Old clients receive the original snapshot protocol. New clients also accept
unstamped snapshots from old servers. The existing v1 envelope remains compatible;
the explicitly negotiated chat stream has its own version and subscription epoch.
A reconnect or detected gap resubscribes with a new epoch and receives a full
snapshot. Duplicates and old epochs are ignored. History revision changes and
chat deletion use full snapshots. Terminal frames and the initial history window
are unchanged.

One encoder retains only the latest recent window, not a delta log. At most four
subscriptions per connection retain encoders; additional subscriptions use legacy
snapshots. Windows exceeding 2 Mi serialized characters, or having duplicate IDs,
use full snapshots without retaining the oversized encoder base. Existing transport
limits still apply. Unsubscribe/close releases state. Each connection allows one
snapshot computation in flight and one coalesced refresh; this prevents asynchronous
reads from publishing out of order and coalesces redundant snapshot computations.
Per-broadcast entry fingerprints are shared between subscribers to the same window.

The browser applies patches immutably and preserves unchanged message objects and
metadata-only message arrays. Transcript hydration uses weak caches keyed by those
objects, including tool-call/result pairs; content replacement invalidates the
corresponding result and never mutates a previously published message. It still
traverses the loaded entries when membership changes. This change does not eliminate
server transcript-file reads or all browser list processing.

## Reproduce the baseline

Install dependencies first. Generate the ignored baseline router from the last
pre-delta revision, then alternate snapshot and delta runs on the same fixtures:

```sh
mkdir -p test-artifacts
git show bc032c98525ab721ef0e81a37271ab2fcab9a859:src/server/ws-router.ts > src/server/ws-router.benchmark-baseline.ts
bun --no-env-file scripts/benchmark-transcript.ts --compare > test-artifacts/transcript-comparison.json
```

`--baseline` selects the original router alone; `--delta` selects the current router. Add
`--fixtures=test-artifacts/transcript-fixtures` to export generated long-session
frames for a browser replay. The baseline router is a generated, ignored file;
never copy runtime user data into fixtures. The script reports medians and maxima
of three samples, not statistical p95 estimates from three observations.

Scenarios cover a short window, a roughly 400 kB long window with 1,000 previously
loaded entries, and a roughly 320 kB large-text window. Each replays 60 updates
(one third metadata-only, two thirds append/window slides), with one or three
clients. The large-text scenario represents payload size, not real tool hydration.
Separate tests exercise tool hydration and same-ID replacement.

Measurements include initial/update bytes, process CPU for server and client
stages, wall times, traversed entries and process RSS. Server timing includes
fixture-window generation, JSON-backed history reads and actual router work.
Client timing includes JSON parse, immutable delta merge and transcript processing.
Disk IO, real network, inference and React rendering are excluded. RSS includes
fixtures and captured frames and is not an incremental-cache memory measurement.
Host contention can distort wall times; do not interpret these numbers as application
FPS or end-to-end latency. `scripts/transcript-browser-benchmark.ts` replays the
same generated frames with the actual decoder and hydration functions in a browser;
its scope likewise excludes React rendering and network transfer.

To run the browser replay locally, generate fixtures and a small static harness,
then open `http://127.0.0.1:8000` and click the comparison button:

```sh
mkdir -p test-artifacts/transcript-browser/fixtures
bun --no-env-file scripts/benchmark-transcript.ts --compare --fixtures=test-artifacts/transcript-browser/fixtures > test-artifacts/transcript-browser/comparison.json
bun build scripts/transcript-browser-benchmark.ts --target=browser --outfile=test-artifacts/transcript-browser/benchmark.js
cat > test-artifacts/transcript-browser/index.html <<'HTML'
<!doctype html><title>Transcript benchmark</title>
<button>Run comparison</button><pre>Ready</pre>
<script type="module" src="benchmark.js"></script>
HTML
python3 -m http.server 8000 --bind 127.0.0.1 --directory test-artifacts/transcript-browser
```

## Recorded comparison

An illustrative local run using Bun 1.3.14, three alternating samples per scenario,
produced the following medians. CPU figures are milliseconds summed over all
clients for the replay, not per update; server measurements cover 60 updates and
client measurements also include the initial frame. Bytes exclude the initial frame.

| Window / clients | Update bytes, snapshot → delta | Server CPU ms | Client CPU ms |
| --- | ---: | ---: | ---: |
| Short / 1 | 284,492 → 26,694 | 6.65 → 10.71 | 2.82 → 1.03 |
| Short / 3 | 853,476 → 80,082 | 7.22 → 12.55 | 23.21 → 7.03 |
| Long / 1 | 24,306,573 → 433,895 | 111.27 → 113.40 | 123.37 → 11.37 |
| Long / 3 | 72,919,719 → 1,301,685 | 217.57 → 127.23 | 305.00 → 23.75 |
| Large text / 1 | 19,359,762 → 3,218,070 | 57.38 → 53.82 | 116.25 → 15.57 |
| Large text / 3 | 58,079,286 → 9,654,210 | 139.33 → 52.81 | 253.87 → 22.37 |

Long-window update bytes fell about 98.2%; large-text bytes fell about 83.4%.
Short-window server CPU increased about 0.07–0.09 ms per update, while the
long-window single-client server result was roughly flat. Delta bookkeeping is
not free, and the primary benefit is reduced transfer and browser work.

A separate browser replay of the long-window fixtures alternated snapshot,
delta, delta, snapshot. Across 61 frames, new hydrated object counts were
63,440 for snapshots and 1,080 for deltas; all four runs ended with identical
recent-window IDs. Snapshot processing totals ranged from 1,445–5,067 ms and
delta totals from 148–215 ms. Per-frame p95 ranged from 61–199 ms and 8–33 ms,
respectively. These two runs per mode show substantial host timing variation;
they are diagnostic observations, not a whole-app speedup or FPS guarantee.

Run `bun run check`, `bun run test` and `bun run audit` before publication. Targeted
coverage includes old/new peers, append/replacement/removal/order, null/reset,
duplicates/gaps, reconnect epochs, pagination continuity, bounded encoder count,
coalesced broadcasts, unsubscribe races and immutable cached tool results.
