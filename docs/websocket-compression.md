# WebSocket compression

StillOn negotiates the standard `permessage-deflate` WebSocket extension and
compresses serialized server messages that are at least 32 KiB in UTF-8. There
is no application-specific wire format: browsers that negotiate the extension
decode messages transparently, and peers that do not negotiate it receive the
same JSON in ordinary WebSocket frames.

## Runtime policy

The Bun server uses:

```ts
{
  compress: "shared",
  decompress: "shared",
}
```

Shared streams bound compressor and decompressor state instead of allocating a
dedicated zlib context per connection. On the supported Bun 1.3.x versions,
this mode negotiates `server_no_context_takeover` and
`client_no_context_takeover`, so compression state is reset between messages.

The send path serializes an envelope once, measures it with
`Buffer.byteLength(payload, "utf8")`, and passes an explicit compression flag
to `ws.send()`. Messages below 32,768 bytes are not compressed. This keeps
routine acknowledgements, errors, and incremental events off the synchronous
compression path while covering initial history and other large snapshots.

Bun ignores the compression flag when the peer did not negotiate
`permessage-deflate`, which provides the uncompressed compatibility path. See
[External ingress](external-ingress.md) for the proxy negotiation contract.

## Reproduce the benchmark

The benchmark uses fixed-seed synthetic JSON only. Raw TCP WebSocket clients
measure complete frame bytes, RSV1, and decoded payload equality; they run in
the parent process while every measured server case runs in a fresh Bun
process. Server CPU and RSS therefore exclude client-side inflate work.
`chat-like` repeats structured message/tool text, `mixed` replaces one quarter
of that content with seeded random text, and `high-entropy` uses seeded
base64-like text as a conservative compression case.

Threshold sweep:

```bash
bun scripts/websocket-compression/benchmark.ts \
  --seed 69001 \
  --classes chat-like,mixed,high-entropy \
  --sizes 8192,16384,32768,65536,262144,524288 \
  --clients 1 \
  --modes shared-uncompressed,shared-forced \
  --repetitions 3 \
  --rounds 5 \
  --threshold 32768 \
  --output-json /tmp/stillon-websocket-threshold.json \
  --output-markdown /tmp/stillon-websocket-threshold.md
```

Active-client sweep:

```bash
bun scripts/websocket-compression/benchmark.ts \
  --seed 69001 \
  --classes mixed \
  --sizes 32768,131072,524288 \
  --clients 1,8,32 \
  --modes disabled,shared-uncompressed,shared-threshold \
  --repetitions 3 \
  --rounds 3 \
  --threshold 32768 \
  --output-json /tmp/stillon-websocket-concurrency.json \
  --output-markdown /tmp/stillon-websocket-concurrency.md
```

`--quick` runs a smaller smoke matrix. The full commands above produced 189
fresh-process runs with no dropped sends or backpressure.

## Results

The measurements below used Bun 1.3.14 on macOS x64. Timings are server CPU,
not an end-to-end latency promise. “Wire ratio” includes WebSocket frame
headers but excludes the HTTP upgrade; lower is better. Displayed values are
medians of three fresh-process repetitions. CPU delta is the median of the
per-repetition differences against `shared-uncompressed` with the same corpus,
size, and seed.

| Corpus | Payload | Compressed wire ratio | Server CPU delta/message |
| --- | ---: | ---: | ---: |
| chat-like | 16 KiB | 0.0206 | 0.125 ms |
| chat-like | 32 KiB | 0.0125 | 0.156 ms |
| chat-like | 512 KiB | 0.0045 | 2.417 ms |
| mixed | 16 KiB | 0.5732 | 1.147 ms |
| mixed | 32 KiB | 0.5325 | 1.945 ms |
| mixed | 512 KiB | 0.4597 | 22.594 ms |
| high-entropy | 16 KiB | 0.7566 | 1.428 ms |
| high-entropy | 32 KiB | 0.7549 | 2.951 ms |
| high-entropy | 512 KiB | 0.7533 | 45.207 ms |

The 32 KiB cutoff is deliberately conservative. At that boundary, mixed
synthetic JSON saved about 47% of frame bytes for about 2 ms of server CPU per
message, while highly repetitive chat-shaped JSON saved about 99%. Compressing
16 KiB mixed or high-entropy messages saved only about 7 KiB or 4 KiB in
absolute terms. Long-session snapshots remain well above either threshold.

The active-client runs used the mixed corpus. Each repetition has three
measured rounds, and each row displays the median of three repetitions. The
CPU total therefore contains `clients × 3` messages per repetition. Peak RSS
delta is the sampled server-process peak after warmup minus the connected,
pre-warmup baseline.

| Payload | Clients | Wire ratio | CPU total/3 rounds | CPU delta/message | Peak RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 KiB | 1 | 0.5325 | 12.875 ms | 2.199 ms | 1.93 MiB |
| 32 KiB | 8 | 0.5326 | 52.786 ms | 1.790 ms | 1.94 MiB |
| 32 KiB | 32 | 0.5327 | 172.261 ms | 1.700 ms | 2.08 MiB |
| 128 KiB | 1 | 0.4740 | 25.277 ms | 6.079 ms | 2.10 MiB |
| 128 KiB | 8 | 0.4752 | 156.876 ms | 6.069 ms | 2.29 MiB |
| 128 KiB | 32 | 0.4753 | 577.939 ms | 5.823 ms | 2.29 MiB |
| 512 KiB | 1 | 0.4597 | 76.846 ms | 23.902 ms | 3.29 MiB |
| 512 KiB | 8 | 0.4604 | 560.841 ms | 22.288 ms | 2.96 MiB |
| 512 KiB | 32 | 0.4605 | 2163.795 ms | 21.966 ms | 3.28 MiB |

Shared mode kept the observed compression working set roughly flat as
connections increased, but compression CPU still scales with payload size and
fanout. It is a bandwidth/transfer-latency tradeoff, not free work or a CPU
rate limiter. Bun's incoming WebSocket payload limit remains in force when
compression is enabled; this change does not raise its 16 MiB default.

## Compatibility checks

Automated coverage verifies:

- negotiation, both no-context-takeover parameters, RSV1, and payload inflate;
- small-message bypass and large-message compression;
- a client that omits the extension offer;
- reconnecting with a different negotiation result;
- masked compressed client messages;
- authenticated WebSockets using the trusted public `Host`, `Origin`, cookie,
  and `X-Forwarded-Proto` contract.

The focused suite was run successfully with Bun 1.3.5 (the declared minimum)
and Bun 1.3.14.

The development benchmark and automated tests do not modify or deploy a live
Cloudflare route. After deploying a release, verify the public route in browser
developer tools: `/ws` should open normally, its response should show a
consistent `permessage-deflate` negotiation when the proxy supports it, and a
long chat should load without reconnects. A route that removes the extension
offer should continue to work through the tested uncompressed fallback.
