# Preview navigation

Use **Back** and **Forward** in the right preview toolbar to revisit documents
opened through Markdown links or the panel address field. These controls use the
current project's preview history and keep the StillOn conversation open.
Unavailable directions are disabled. Refresh keeps the current history entry;
opening a new address after Back replaces the forward branch.

**Home** opens the local-server launcher, where history controls are disabled.
Each project retains its own preview history when the pane is closed and reopened.
The isolated browser reports ordinary navigation, SPA history changes and
fragments to the panel. Open standalone uses the current reported address.
Refresh makes a GET request and never replays a submitted POST form.

![Preview toolbar with independent Back and Forward controls](images/preview-navigation.png)
