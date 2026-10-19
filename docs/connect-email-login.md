# Connect email login

The officially hosted Connect account service and login portal are maintained
in a separate private repository. This public repository retains the local
email-linking client and shared device/session protocol. See
[repository layout](repository-layout.md) and
[remote access](connect-remote-access.md).

Link an email from Settings → Remote access on the computer, verify the code,
then sign in to the configured Connect service from a remote browser. A login
proves access to that inbox; computer access additionally requires ownership,
a host-specific session and a valid transport lease. Email login does not
sign in to Claude Code or Codex.

The existing six-digit, ten-minute code and remembered-session behavior remain
unchanged by the repository split. Verification codes are single-use and bound
to the initiating browser/enrollment. Logout revokes the current browser's
session family while preserving computer bindings and local work.

Mail-provider setup, account persistence, cloud secrets and service operation
commands belong to the private service repository. Do not add mail API keys or
cloud account secrets to the public app or desktop packaging. Public local
builds and self-managed remote ingress do not require these credentials.
