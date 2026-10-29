# Sidebar loading

Local and Connect browsers use the same opt-in protocol-1 sidebar subscription.
A `view` with `version: 1` and an empty `groups` array requests an authoritative
workspace catalog with no active or archived conversation names. It includes
ordering, default-collapse hints, activity/notification summaries and counts.
The existing workspace-scoped authorization filters the store before projection.

The browser requests five conversations for each expanded workspace. “Show more”
increases that workspace's requested prefix by twenty; “Show less” restores five.
These are live replacement windows, not an append-only cursor: pinning, archiving,
renaming and new conversations retain server ordering without duplicate rows or
stale offsets. A collapsed workspace has no requested window, including on
reconnect. Already revealed prefix size is retained while the same sidebar stays
mounted; reloading starts again at five. No background full-history fetch follows
startup.

Home readiness waits for the catalog, settings, projects and committed composer,
not for conversation windows. An explicitly opened conversation still waits for
its own transcript/preferences. Its catalog lookup identifies its workspace even
when its row is outside the current window; opening that workspace can include
the selected row in addition to the five-row preview.

Searching is an explicit, debounced projection over active conversations, including
collapsed workspaces, with fifty additional matches at first and more on explicit request. Archives are requested
only when their dialog opens, twenty at a time. Both operations preserve workspace
scope. Notifications and workspace activity remain accurate for unloaded rows.

Clients without `view` keep the complete legacy snapshot. Hosts without view
support continue to return complete snapshots to new browsers. Compact sidebar
encoding preserves the projection metadata and existing row references. Changing
the requested view replaces the subscription; late replies cannot apply to the
new view. Reconnect replays the current request, and persisted collapse writes
retain their existing retry/version protection.
