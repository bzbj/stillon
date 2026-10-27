# Shared workspaces

A computer's owner can invite verified email addresses from the workspace menu's
**Share** dialog. Local access and the linked owner's authenticated Connect access
have the same sharing controls: invite, copy invitation, remove a person and
**Stop sharing**. Connect must be linked first. There are no configurable roles.

Invited people sign in with the invited email, accept the invitation and open the
workspace from Connect. Shared entries and the invited workspace title use
**Machine Name - Workspace**. Each shared workspace has its own browser origin
under the existing Connect wildcard, so tabs cannot retarget one another.

Invited people see only the assigned workspace's StillOn sessions. They cannot
create/open other workspaces or manage invitations. Everyone in the workspace can
create, continue, interrupt, rename, archive, restore and delete its conversations;
these operations affect the same local data. Different conversations can run in
parallel. Concurrent input uses the existing agent queue, and cancellation carries
the observed run ID so a delayed stop cannot cancel a later run.

The selected sharing indicator stacks a smaller, lighter copy of the workspace
avatar at its lower left, preserving the existing activity indicators. Sharing
ends when all invitations/access are removed; conversations and files remain.
Drafts remain private to each browser until sent.

Agent and terminal execution use the computer's existing provider configuration,
credentials and operating-system permissions. Workspace restrictions apply to
StillOn's resource APIs and navigation; they do not introduce an execution sandbox.

The public application owns the UI, connector, signed ingress scope and local
resource checks. The account service owns verified identities, invitations,
acceptance, access revocation and routing. Older gateways/hosts continue supporting
owner access; invited execution requires a host advertising sharing support.
