# Debug session statistics

Statistics are off by default. Enable **Settings → Usage → Debug session statistics** before creating a session to collect tokens, speed and timing. Existing sessions are not enrolled or backfilled. Disabling the switch stops collection and hides the controls; recorded data is retained. Re-enabling starts a new debug window for new sessions only. The preference follows the host across local and Connect entries.

Claude Code partial-message frames are used only by statistics, so StillOn
requests them only for sessions that are enrolled. The Claude Agent SDK passes
that choice to the Claude Code process when its query starts and has no way to
change it afterwards. Each time StillOn creates a query (a new session, a fork,
or a change of working directory, effort or permission mode that restarts it),
it asks for partial messages only if that chat is enrolled in the current debug
window. A query started for an unenrolled session never requests them and is
never observed later. A query already running when collection is disabled keeps
receiving frames until it next restarts or the app stops it; StillOn drops them
without observing, storing or broadcasting them, but they still cross the
process pipe. StillOn does not restart a conversation just to stop that traffic.

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

Forked conversations keep their copied context and start statistics at zero.
Each branch counts only its own subsequent input, cache and output usage, plus
its own timing. Reusing inherited context in a new request still counts as
input/cache usage for that request. Parent statistics remain unchanged.
Forks retain this scope across restart and nested forks; their per-step native
usage feeds the original DSH fold instead of inheriting Codex thread totals.
DeepSeek Harness forking is currently unsupported.

Codex App Server's native cumulative counters also cover ordinary resumed threads.
Sessions created before enabling debug statistics remain uninstrumented. Codex exec supplies aggregate tokens
but lacks model-step stream timing, so it shows tokens without a speed control.
Native DSH's session projection has no separate cumulative reasoning counter.

Statistics are stored as bounded per-chat checkpoints and survive history
pagination, process restarts and log compaction. Only numeric boundaries and
buckets are added to storage; token text is not duplicated into statistics.

Run the synthetic observation/storage benchmark with
`bun scripts/benchmark-session-statistics.ts`. It compares collection and
checkpoint writes against the same transcript writes without collection. Results
include process CPU time, sampled RSS/heap peaks, the p95 assistant-transcript
append duration and final statistics-drain time. Memory samples include earlier
rounds in the same process; they are not isolated per-session allocations. The
benchmark does not measure real provider throughput, first-token latency or
network latency. Coalesced log sizes depend on the synthetic run duration.

## Background collection and persistence

Response processing queues statistics without waiting for statistics storage.
A background task folds observations in order and coalesces checkpoints once per
second, with at most one append in flight. Checkpoints use `statistics.jsonl`
and a write queue independent of transcripts and turn state. Compaction and
recovery include both old statistics in `chats.jsonl` and the new journal.

The local and Connect chat streams publish statistics at most once every ten
seconds while a turn runs. Ordinary text and tool updates keep the last published
statistics view. Completion, cancellation and errors publish the final view
immediately and request a background checkpoint; they do not wait for its disk
write. Normal shutdown drains pending statistics. A crash can lose the last
unflushed batch, or more if storage is stalled.

Disabling debug statistics discards pending observations, checkpoints that have
not started writing, and scheduled statistics publications. An append already
in progress may finish. Earlier saved statistics are retained; re-enabling
still enrolls only newly created chats.

Pending observations are limited to 4,096 entries and approximately 4 MiB of
serialized text. Overflow, malformed observations or statistics storage failure
stop collection for the affected chat and mark its statistics incomplete.
Statistics failures do not reject ordinary transcript or turn writes. Background
folding and storage still consume local resources; this removes the direct
statistics I/O dependency from response consumption, rather than eliminating all
instrumentation overhead.
