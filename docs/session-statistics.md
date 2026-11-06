# Session statistics

Enable **Settings → Usage → Show session statistics** to show output speed and
cumulative tokens above the conversation composer. Both controls open detailed
popovers. The preference defaults to off and follows the host across local and
Connect entries. Hiding the controls does not stop collection.

Token totals sum four disjoint buckets: uncached input, cache reads, cache
writes and output. Reasoning tokens are already included in output. **B** means
one billion tokens. The popover includes the exact total.

DeepSeek Harness sessions read native `tokenUsage` and `sessionStats`
projections inside the existing SDK process. Codex App Server and Claude Code
protocol events feed the vendored DSH 0.2.2-rc.1 folds. See
[src/shared/vendor/dsh](../src/shared/vendor/dsh/README.md) for provenance.
Speed is total completed-step output tokens divided by total decode time;
decode time runs from the first qualifying text, reasoning or tool delta to the
assembled assistant message. The original retry, replacement, cancellation,
overlapping-tool and short-window behavior is preserved. There is no smoothing.

Codex App Server's native cumulative counters also cover resumed threads.
Older Claude sessions without recorded usage show their recording start time;
missing historical usage is not estimated. Codex exec supplies aggregate tokens
but lacks model-step stream timing, so it shows tokens without a speed control.
Native DSH's session projection has no separate cumulative reasoning counter.

Statistics are stored as bounded per-chat checkpoints and survive history
pagination, process restarts and log compaction. Only numeric boundaries and
buckets are added to storage; token text is not duplicated into statistics.

Run the synthetic observation/storage benchmark with
`bun scripts/benchmark-session-statistics.ts`. It compares collection and
checkpoint writes against the same transcript writes without collection; it
does not measure real provider throughput or network latency.
