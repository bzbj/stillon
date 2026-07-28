# Transcript delta streaming

StillOn keeps the initial chat hydration as a full snapshot, then uses
subscription-scoped delta events for clients that opt in with:

```ts
{
  type: "chat",
  chatId,
  recentLimit: 200,
  stream: { version: 1 },
}
```

The outer WebSocket protocol remains version 1. This preserves the mixed-version
fallback:

- An old client does not request streaming, so a new server keeps sending full
  snapshots.
- A new client can request streaming from an old server; the old server ignores
  the extra topic field and keeps sending full snapshots.
- A new client and server exchange one full baseline followed by deltas.

## Delivery and recovery

The full baseline carries a connection-local stream revision and sequence zero.
Each delta names its base sequence and resulting sequence. The client applies a
delta atomically only when the chat, stream revision, and next sequence match.

Duplicate frames are ignored. A missing baseline, revision mismatch, sequence
gap, out-of-order frame, or impossible transcript operation marks the
subscription as waiting for resynchronization. The client then repeats the same
subscribe ID once, and the server responds with a new full baseline and stream
revision.

This stream revision is deliberately separate from `history.revision`.
`history.revision` remains the paging epoch used by append-safe older-history
cursors; ordinary appends must not invalidate it.

Transcript patches preserve server order and support:

- recent-window eviction by stable transcript `_id`, which the client retains as
  paged history;
- structural removal by stable transcript `_id`, which is also purged from
  locally retained history;
- same-position replacement by `_id`;
- ordered tail append; and
- an authoritative reset carrying both messages and paging metadata.

The normal production write path is append-only. Replacement, removal, and
reset are protocol/reducer capabilities for recovery and future mutation paths.

## Server fast path

`EventStore.appendMessage()` records successful JSONL appends in a process-local
journal after the disk append completes. The journal is globally bounded across
all chats to 512 records and 4 MiB of UTF-8 JSONL bytes.

Initial recent history and its delivery head are captured at the same
`writeChain` barrier. After that baseline, the router reads only:

- journal entries newer than the subscription head; and
- lightweight runtime, queue, and provider metadata.

It does not page or serialize the full recent transcript for a normal append or
metadata-only update. Concurrent snapshot broadcasts are serialized per socket,
and delivery state advances only after Bun accepts or queues the WebSocket
frame.

The router falls back to a new full baseline when the journal no longer covers
the subscriber, the journal revision changes, the recent-window paging cursor
must first be established, one journal batch is larger than the requested
recent window, the chat disappears, or the subscription reconnects or
explicitly resubscribes.

## Synthetic benchmark

Run:

```bash
bun run benchmark:transcript-deltas
```

The benchmark uses generated data only. It does not inspect local StillOn
sessions. The recorded run used Bun 1.3.14 on macOS x64 with:

- a 200-entry, 679,374-byte (0.648 MiB) recent snapshot;
- 64 post-hydration frames;
- 2 warm-up and 9 measured runs; and
- either no retained older entries or 5,000 synthetic retained entries.

Serialized UTF-8 application payload bytes after initial hydration:

| Workload | Frames | Full snapshots | Deltas | Delta/full | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rolling append | 64 | 41.49 MiB | 0.23 MiB | 0.54% | 99.46% |
| Runtime only | 64 | 41.47 MiB | 0.03 MiB | 0.07% | 99.93% |

Client JSON parse plus state/reconciliation time per 64-frame interval:

| Workload | Retained older | Full median / max | Delta median / max | Median speedup |
| --- | ---: | ---: | ---: | ---: |
| Rolling append | 0 | 98.058 / 175.441 ms | 29.536 / 55.015 ms | 3.32x |
| Rolling append | 5,000 | 407.557 / 452.976 ms | 335.319 / 341.811 ms | 1.22x |
| Runtime only | 0 | 89.374 / 151.482 ms | 5.714 / 11.927 ms | 15.64x |
| Runtime only | 5,000 | 258.057 / 295.817 ms | 4.349 / 7.481 ms | 59.34x |

The client timing includes JSON parsing, stream reduction, bounded recent-window
pagination reconciliation, and a synthetic loaded-history merge/scan. It
excludes the initial full hydration, network transport, WebSocket compression,
and DOM rendering, so absolute numbers are machine-specific.

Rolling appends still reprocess retained loaded history in the existing render
pipeline. Delta streaming removes the repeated large parse and transfer, but
incremental transcript hydration remains a separate opportunity for very large
locally retained histories.

The benchmark enforces the payload-size bounds, runtime-only timing improvements,
and rolling-append timing with no retained older history. The 5,000-entry
rolling-append row is reported but not used as a timing gate because both paths
still pay the same existing linear retained-history merge cost.
