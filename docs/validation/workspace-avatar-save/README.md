# Workspace avatar save validation

The screenshots use synthetic data with the actual WorkspaceAvatarPicker,
workspace avatar store and avatar rendering components. A real StillOn server
runs behind an isolated proxy that presents an explicitly allowed HTTPS origin
to its HTTP upstream.

- `error-retry.png`: an injected plain-text403 produces a readable error while
  retaining the selected shape/color and retry controls. The next save succeeds.
- `mobile.png`: the390px dialog retains the saved choice and exposes Save avatar.
  Changing and saving it updates both displayed workspace avatars after reload.

Integration regressions cover the passwordless HTTPS proxy, the optional app
password, invalid/missing origins, invalid Host, cross-site writes and unknown
workspaces. A signed Connect adapter test verifies persistent saves and rejects
requests without a lease. Client regressions cover non-JSON errors, expired
sessions, successful retries and invalid successful responses.
