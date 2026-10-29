# Workspace startup snapshots

The client requests application settings and local projects before model catalogs,
keybindings, the sidebar and chat/terminal snapshots. It preserves that priority
when restoring subscriptions after reconnecting. The startup readiness conditions
still require authoritative sidebar data, project data and settings, plus the
route's required UI parts.

Sidebar subscriptions opt into `compactVersion: 1`. For those subscriptions the
server may send a sidebar snapshot with top-level `sidebarEncoding: 1`. Each
project group retains `chats` and `archivedChats`; `previewIndexes` and
`olderIndexes` replace the duplicate `previewChats` and `olderChats` row arrays.
Indexes address `chats`, preserve each bucket's order, and partition its rows.
The client reconstructs the ordinary `SidebarData` before notifying UI listeners
or storing a sidebar snapshot. No rows or membership information are dropped.

Old subscriptions keep receiving full snapshots. New clients also accept full
snapshots from older hosts. Noncanonical server buckets fall back to the full
representation instead of losing data. Invalid compact references cause the
client to reconnect before applying sidebar state. Protocol version 1 and the
existing transport flow-control and authorization checks are unchanged.

This reduces sidebar bytes and keeps small startup snapshots out of the wait for
a large sidebar's final acknowledgement. It does not bypass authentication,
remove the startup readiness gate, or promise a fixed end-to-end loading time.
