# Sidebar loading

Local and Connect browsers use the same opt-in protocol-1 sidebar subscription.
A `view` with `version: 1` and an empty `groups` array requests an authoritative
workspace catalog with no active or archived conversation names. It includes
ordering, default-collapse hints, activity/notification summaries and counts.
The existing workspace-scoped authorization filters the store before projection.

Current browsers additionally send `previewVersion: 1`. The initial response
preloads a base preview for **every** workspace, including folded workspaces:
all pinned conversations, followed by the newest unpinned conversations only
until the preview reaches five rows. A workspace with seven pins shows all seven
and no unpinned rows; a workspace with fewer than five total rows shows them all.
The response echoes `previewVersion: 1` and each group's `chatPage.previewLimit`.

Opening or folding a workspace does not request its base preview again. “Show
more” increases that workspace's requested prefix by twenty beyond its current
preview/window; “Show less” and folding restore the base preview immediately.
These are live replacement windows, not an append-only cursor: pinning, archiving,
renaming and new conversations retain server ordering without duplicate rows or
stale offsets. A collapsed workspace has no extra-history window, including on reconnect.
Previews stay present when an extra-history subscription is removed. No background
full-history fetch follows startup. Only user intent fetches rows beyond the base
preview. Conversations can continue updating in the preloaded preview without
waiting for the workspace to be opened.

Home readiness waits for the initial preview-bearing catalog, settings, projects
and committed composer, not for extra-history windows. An explicitly opened conversation still waits for
its own transcript/preferences. Its catalog lookup identifies its workspace even when its row is outside the
preview; a direct link does not insert an unpinned row into an all-pinned preview.

Searching is an explicit, debounced projection over active conversations, including
collapsed workspaces, with fifty additional matches at first and more on explicit request. Archives are requested
only when their dialog opens, twenty at a time. Both operations preserve workspace
scope. Notifications and workspace activity remain accurate for unloaded rows.

Clients without `previewVersion` keep the earlier catalog-only lazy behavior;
new clients detect that response and retain the old expansion request path.
Clients without `view` keep the complete legacy snapshot. Hosts without view
support continue to return complete snapshots to new browsers. Compact sidebar
encoding preserves the projection metadata and existing row references. Changing
the requested view replaces the subscription; late replies cannot apply to the
new view. Reconnect replays the current request, and persisted collapse writes
retain their existing retry/version protection.
