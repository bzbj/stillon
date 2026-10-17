# Generated HTML link navigation

Generated HTML keeps its opaque sandbox and folder-scoped resource capabilities.
An ordinary link to a supported preview file in the same folder now opens through
the Browser pane's controlled history. Back and Forward restore the previous
preview without navigating the conversation or clearing its draft.

The parent accepts navigation messages only from its current opaque iframe.
Targets must remain in the current workspace and preview folder. App APIs,
other workspaces, traversal, hidden files and unsupported schemes are rejected.
Downloads, modified clicks, explicit new-tab links and fragment-only links retain
their existing browser behavior. External-site iframe history is unchanged.

Validation used an isolated Connect service and the real BrowserPanel component:

- A relative PNG loaded through the cloud capability without app cookies.
- Clicking the image enabled Back; Back restored the report and Forward reopened
  the image, with the parent URL and conversation draft preserved.
- A linked HTML detail page returned through the same pane history.
- A forged request to navigate to an application endpoint was ignored.
- Preview scripts ran while access to the parent document remained blocked.
- Wrapping an already wrapped computer response produced one cloud base and one
  navigation bridge, with no local capability left in the HTML.

Source tests also cover capability expiry/revocation, cross-host access,
write rejection and escaping symlinks. Deploying the Connect service and updating
the computer client are both required for the complete remote behavior.
