# Install StillOn with your coding agent

StillOn is designed for people who already work with Codex or Claude Code. Copy the prompt below into your coding agent to install StillOn from its official source repository.

<!-- prompt:start -->
Install StillOn from its official source repository:
https://github.com/bzbj/stillon

Goal: set up StillOn on this computer for local use first, without exposing it to the LAN or public internet. Installation is not complete until the new StillOn instance has passed its first-use checks.

Please:
1. Read the repository README and SECURITY.md before making changes.
2. Inspect this computer's operating system, shell, Bun availability and version, and any existing StillOn installation.
3. Explain the installation plan briefly, then follow the repository's official steps for this platform.
4. Preserve any existing user data or configuration. Do not overwrite or remove an existing installation without asking.
5. Before the first StillOn start, ask me what this instance should be called. This is the user-facing **Machine Name** shown in the StillOn sidebar and browser tab. Do not invent or overwrite a name. After I answer, set `STILLON_MACHINE_NAME` in StillOn's dedicated configuration before first launch. If an existing StillOn settings file already has a machine name, preserve it and tell me how to change it in **Settings → General → Machine Name** instead.
6. Build and start StillOn locally, then verify its health endpoint and the browser app on localhost. Report the exact local URL, installed revision/version, process state, log location, update procedure, and rollback or uninstall steps.
7. Complete a first-use Claude Code readiness check:
   - Detect the `claude` command and report its version without changing its configuration.
   - Check its authentication status. If Claude Code is missing or not authenticated, explain the required interactive `claude login` step and ask before starting it. Never ask for, copy, or print credentials, browser codes, or session tokens.
   - After authentication succeeds, ask before running one minimal, disposable Claude Code prompt that makes no project changes. Confirm both the CLI result and, where browser interaction is available, a new Claude chat inside StillOn.
   - If any check cannot be completed, leave StillOn running, report the precise failed prerequisite and the safe next action; do not silently claim setup succeeded.
8. If this installation is replacing Kanna, keep Kanna and its data untouched until StillOn has passed the health and Claude Code checks. Only then offer a separately confirmed cutover or shutdown; Kanna must never be used as StillOn's runtime dependency.
9. Offer the optional per-user background service only after explaining what it changes.

Safety constraints:
- Keep StillOn bound to localhost by default.
- Do not use --remote, --share, --cloudflared, firewall changes, DNS changes, Tailscale, or any public tunnel unless I explicitly request remote access separately.
- Do not expose secrets in shell history, logs, source files, or chat output.
- Before any privileged or destructive action, or any change to an existing service, explain it and ask for confirmation.
- Treat provider test prompts as billable or quota-consuming work: run them only after I explicitly approve the test.
<!-- prompt:end -->

Remote access is intentionally a separate step. After local installation and the Claude Code first-use check work, choose a private-network or Cloudflare Tunnel recipe from the project documentation.

## What this prompt considers “done”

The coding agent is the installation concierge; StillOn is the application the
user will use afterwards. A successful run therefore has four observable
outcomes: a named StillOn instance, a healthy local server, a verified Claude
Code login, and one opt-in end-to-end provider check. A future in-app welcome
flow can present the same checklist persistently, but it should use the same
safe boundaries: name first, local-only by default, explicit login consent,
and an opt-in provider test.
