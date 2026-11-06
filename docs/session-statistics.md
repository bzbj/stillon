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
checkpoint writes against the same transcript writes without collection; it
does not measure real provider throughput or network latency.
