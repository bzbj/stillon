# Persistent schedules

Open the clock beside Browser in a conversation's top bar. The existing right
sidebar lists **all schedules in the current Workspace**, with a separate result
conversation for each. Opening a schedule shows its prompt, provider, model and
recent runs. Switching conversations within that Workspace keeps the same list.

Create and manage schedules through conversation:

- “Every weekday at 09:00 Asia/Singapore, review changes and report here.”
- “In 30 minutes, check whether the build finished.”
- “Pause the daily project check.”
- “Change the daily project check to 10:00.”
- “Delete the release reminder.”

Workspace options → 定时任务 opens the same panel even when the Workspace has no conversations.

The plus action lets you choose the current conversation (showing its title) or
create a new conversation in that Workspace. Without an active conversation, only
new conversation is offered. Both actions prefill the existing composer and
preserve the original conversation’s draft. Editing from the Workspace view
opens the plan’s existing result conversation; the edit prompt keeps that target.
They do not send a message. There is no separate creation form. Send one message
in a target conversation before scheduling it so its execution preferences exist.
The target must belong to the same Workspace.

## Execution and recovery

StillOn must be running on the host to execute work. Schedules survive restarts
in `schedules.sqlite`, independently of chat snapshots. Daily and weekday plans
use their saved IANA timezone. A nonexistent daylight-saving time is skipped;
a repeated wall time runs only at its first occurrence.

After downtime, one overdue occurrence runs; missed intervals are not replayed
as a backlog. A busy target, paused message queue or still-stopping target skips that occurrence.
At most two scheduled turns run concurrently. A missing target or launch failure
blocks the run and pauses its schedule. An interrupted run whose outcome cannot
be established is retained for review and never automatically replayed.

Each plan saves its provider, model, permission settings and plan mode. A
scheduled turn uses those saved preferences and ordinary provider permissions.
Plan-mode conversations cannot schedule non-plan work. Automated turns can
inspect schedules but cannot create, edit or delete them.

The scheduled prompt, progress and result appear in its target conversation.
Persisting a new scheduled prompt automatically restores an archived target to
the normal conversation list. Skipped and blocked launches with no new prompt
do not restore it. The app does not navigate away from the current page.
Stopping a turn does not pause its future schedule; request that separately.

The host owner can manage schedules locally or through authenticated Connect.
Shared Workspace guests cannot manage or subscribe to them. Provider tools use
an authenticated loopback bridge, rechecked against the current authorized turn.
Mutation operation IDs make response retries return the original result without
creating a second plan. Only one StillOn process can control a schedule database.
A schedule storage failure disables scheduling while leaving conversations usable.

This version supports one-time and weekly wall-clock recurrence (including daily
and weekdays). It manages StillOn schedules only; it does not discover Codex App
automations or move schedules between Workspaces.
