# Async answer delivery feedback — issue #170

The card now acknowledges a click immediately, freezes the visible answers, and distinguishes sending, disconnected waiting, queued, accepted, unconfirmed, unknown and failed delivery. A failed answer retains the draft and allows an explicit new attempt. Unknown delivery only offers a real status query.

## State and recovery

- `AsyncQuestionDelivery` is one observable store per socket, keyed by `(chatId, questionKey)`. The React card subscribes with `useSyncExternalStore`. A synchronous guard is installed before dispatch, so duplicate click, touch and keyboard activations cannot create a second logical submission.
- A UUID is created for a logical attempt and remains attached to its immutable answer payload. Tab-scoped `sessionStorage` retains that ID and answers across remounts and reloads. A reload turns an unresolved local submission into `delivery_unknown`, then queries the durable server record. Confirmed failed answers may be edited and sent with a new UUID.
- Both command ACKs and snapshots update the store. Accepted cannot regress; queued cannot regress to submitting/unknown. An answer from another client is adopted from the server instead of overwritten.
- Ten seconds is a feedback threshold, never a failed-delivery verdict. The answer-level status query has its own bounded waiter; aborting it removes its pending entry. The original answer is not retried because an ACK is missing.
- `chat.getAsyncQuestionResponse` validates the chat and returns its existing answer record or null. It does not send, drain, reconcile, or wait behind an in-flight provider submission. A still-submitting record remains unconfirmed and can be checked again.
- Disconnect/reconnect queries unresolved records. An original unsent outbound envelope remains the only delivery path and flushes once. There is no additional resend path. Once a durable queued/accepted/failed fact is known, cancellation releases the original waiter and safely removes any remaining unsent envelope. A null query result is insufficient proof of non-delivery and never enables direct resend.
- Existing native steer / same-thread follow-up routing remains. Two unsafe failure classifications were tightened: a transport error while the original turn still runs is unknown unless refusal is confirmed; an incomplete record without a durable queue entry after restart is also unknown. This prevents a user retry from duplicating a delivery that may already have happened.
- Read-only exports show historical answers and status without send, retry or query controls. Error text is sanitized inside the card.

## Reproduce browser acceptance

Install dependencies and a Playwright browser, then run:

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run test:async-answer:browser
```

On Windows with Edge installed, set `STILLON_TEST_BROWSER_CHANNEL=msedge` before the browser command. Node.js 20+ runs the bundled Playwright driver; Bun runs the isolated Vite fixture. The fixture listens only on `127.0.0.1:5189`, uses synthetic questions/answers, and never accesses a real agent or production data. Generated screenshots are in `test-artifacts/async-answer/`; `STILLON_TEST_ARTIFACT_DIR` can select a different output directory.

The committed fixture is also an interactive reproduction: start Vite on port 5189 and open `/scripts/test-fixtures/async-answer/index.html`. Select HTML and fill the second answer, then click Send. The card immediately shows sending while the fake ACK is held. In the browser console run `fixture.record('accepted'); fixture.disconnect()`, then `fixture.reconnect()`. It queries the saved server fact and shows accepted, without sending another answer. `fixture.commands` exposes the synthetic command counts. `fixture.ack('queued')`, `fixture.ack('failed')`, and `fixture.ack('delivery_unknown')` reproduce the other states.

## Diagnostics

Enable client metadata with `sessionStorage.setItem('stillon:debug-async-answers', '1')`; remove that key to disable it. Enable server metadata with `STILLON_DEBUG_ASYNC_ANSWERS=1` in an isolated test service. Both use `[stillon/async-answer]`. The stages cover click, connection, local enqueue, actual send, server receive, ACK and state transitions, correlated by submission/command IDs and elapsed milliseconds. The allowlisted metadata excludes question keys, question/answer text, provider error text, addresses, credentials and transcript content. No private logs are committed.

## Acceptance matrix

Local browser verification used headless Edge on Windows ARM64 with a real React root, real `StillOnSocket`, controlled WebSocket delivery, and Playwright time control. These are component/transport integration checks, not static-markup checks.

| Item | Verification and result |
| --- | --- |
| T01 | PASS: delayed ACK; immediate disabled sending button, live status, frozen visible answers. |
| T02 | PASS: synchronous repeated click dispatch, keyboard Enter/Space repeats, and actual repeated touchscreen taps; one answer command/ID. Server duplicate-delivery tests independently verify one provider delivery. |
| T03 | PASS: incomplete multi-question answers and whitespace block send; custom text submits. |
| T04 | PASS: ACK-first and snapshot-first; late submitting cannot regress accepted. Explicit queued, failed and unknown states are exercised. |
| T05 | PASS: disconnected click shows waiting; original local queue flushes once after reconnect. |
| T06 | PASS: an OPEN but silent socket reaches unconfirmed after 10 seconds, executes a real query, times that query out, and never fails/replays the answer. |
| T07 | PASS: accepted server record with lost ACK restores after reconnect query; no second answer command. |
| T08 | PASS: queued survives disconnect, remount and reload, keeps the answers, and advances on an accepted snapshot. No answer command is created by reload. |
| T09 | PASS: unknown queries really execute; error feedback retains unknown, successful query adopts accepted, no direct resend. |
| T10 | PASS: confirmed failed draft/selection remain; edited retry uses a different UUID. Service tests verify a failed attempt can be retried with new ID/answers. |
| T11 | PASS: switching chats, remount and reload preserve original binding and unresolved answers; no wrong-chat or duplicate command. |
| T12 | PASS: service/provider tests cover native steer, one ended-turn follow-up, confirmed refusal fallback, ambiguous transport delivery, and crash-left records. No real provider session was disturbed. |
| T13 | PASS: another client's server answer becomes authoritative without replacing its answers or sending another command. |
| T14 | PASS: accepted static export regression plus browser unknown/failed histories; answers visible, no actions. |
| T15 | Automated PASS: 320/375/1280 px, long questions/unbroken answers, no horizontal overflow, keyboard activation and retained focus, polite live status, reduced-motion spinner. Manual screen-reader speech and a physical mobile device were not tested. |
| T16 | PASS: enabled client and server diagnostic tests contain IDs/timing/stages and exclude synthetic private question/answer sentinels. |

## Local checks

- Required four-file regression plus router and query-race store tests: **73 passed, 0 failed** (the original four-file baseline was 27).
- `bun run check`: passed (TypeScript, client build, export-viewer build).
- `bun run audit`: passed.
- Initial full suite: 1,159 passed, 9 skipped, 11 failed. All 11 failures are `EPERM` at fixture symlink creation in the unchanged updater `source-links.test.ts`, because this workstation lacks Windows symlink creation privilege. The updater directory is byte-for-byte unchanged against main. The separate router/terminal run passed 36 with 8 platform skips. Cross-platform CI is required before merge; this local limitation is not represented as a full-suite pass.
- No production service was restarted or upgraded.

## Actual component screenshots

| State | Desktop | Mobile |
| --- | --- | --- |
| Sending | [1280](screenshots/1280-sending.png) | [375](screenshots/375-sending.png) |
| Waiting for connection | [1280](screenshots/1280-waiting.png) | [375](screenshots/375-waiting.png) |
| Queued | [1280](screenshots/1280-queued.png) | [375](screenshots/375-queued.png) |
| Accepted | [1280](screenshots/1280-accepted.png) | [375](screenshots/375-accepted.png) |
| Failed | [1280](screenshots/1280-failed.png) | [375](screenshots/375-failed.png) |
| Unknown | [1280](screenshots/1280-delivery_unknown.png) | [375](screenshots/375-delivery_unknown.png) |
