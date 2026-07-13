# Install and configure StillOn with your coding agent

StillOn is designed for people who already work with Codex or Claude Code. Copy the prompt below into your coding agent. It will install StillOn from its official source repository, then guide local first use and your first message. External access is a separate operator-managed step.

<!-- prompt:start -->
Install StillOn from its official source repository and complete first-use setup:
https://github.com/bzbj/stillon

Act as my installation and first-use guide. Do not treat a running service as “done”: make local use work first, then help me send my first message in StillOn. Treat LAN or Internet access as a separate, explicit external-ingress task rather than part of installation.

Before making changes, ask these three short questions:
1. What should this instance’s **Machine Name** be?
2. Do I want to use Codex, Claude Code, or both first?
3. After local first use, do I want to keep it on this computer only, or discuss a separate external-ingress plan for LAN or Internet access?

If I have not chosen an access path yet, complete local setup first. Interest in external access is not authorization to configure it: explain the external-ingress contract and wait for a separate, explicit request. Do not guess for me or assume that I want network exposure.

Please:
1. Read the repository README, SECURITY.md, and the platform-specific installation documentation before making changes.
2. Inspect this computer's operating system, shell, Bun availability and version, and any existing StillOn installation. Briefly explain the plan, then follow the repository's official steps for this platform.
3. Preserve existing user data and configuration. Do not overwrite, remove, or stop an existing installation without asking.
4. Before the first StillOn start, use the Machine Name I provide. Set `STILLON_MACHINE_NAME` in StillOn's dedicated configuration before first launch. If an existing StillOn settings file already has a machine name, preserve it and tell me how to change it in **Settings → General → Machine Name** instead.
5. Build and start StillOn locally, then verify its health endpoint and the browser app at `http://127.0.0.1:3210` (or its actual port). Report the exact local URL, installed revision/version, process state, log location, update procedure, and rollback or uninstall steps.
6. Check Codex and Claude Code availability, but require a first-use check only for the provider I choose:
   - Report whether `codex` and `claude` are installed and their versions. Do not change either provider's configuration on your own.
   - For Codex, use `codex login status` to check authentication. If it is not authenticated, explain the interactive `codex login` next step and ask before launching browser login or device authentication.
   - For Claude Code, check authentication using its documented flow. If it is missing or unauthenticated, explain the required interactive login and ask before starting it.
   - Do not block StillOn because the provider I am not using is missing. State the exact missing prerequisite instead. Never ask for, copy, or print credentials, browser codes, session tokens, or API keys.
7. After local verification, keep the `127.0.0.1` binding, give me the precise URL, and wait for me to confirm that it opens in a browser. Explain that LAN and Internet access are separate operator-managed ingress tasks. If I ask to consider either, first explain the local [external-ingress contract](external-ingress.md) and the security impact. Do not create or administer a proxy, tunnel, firewall, DNS record, Cloudflare resource, VPN, Tailscale setup, public URL, `--host`, `--remote`, or `--trust-proxy` as part of installation. `--share` and `--cloudflared` are not StillOn features. Let me choose the operator-managed proxy, tunnel, or direct-listener approach in a separate explicit request.
8. Once the local origin and chosen provider work, guide my first message:
   - Create a new StillOn conversation with my chosen provider. Before sending a provider message, show me the proposed text and ask for confirmation because it may use quota or cost money.
   - If I do not yet have a task, suggest this harmless opener: `Please confirm that I am connected to StillOn. Do not modify files or run commands; in one sentence, tell me how you can help me here.`
   - If you can interact with the browser, send it in StillOn and confirm a reply arrives. If you cannot, give me the exact click path and wait for my result. If there is no reply, state the specific blocker and safe next action; do not claim first-use setup is complete.
9. If this installation replaces Kanna, keep Kanna and its data untouched until StillOn has passed the local health check and the first-use check for my chosen provider. Only then offer a separately confirmed cutover or shutdown; Kanna must never be StillOn's runtime dependency.
10. Offer the optional per-user background service only after explaining its effect and receiving confirmation.

Safety constraints:
- Keep StillOn bound to localhost by default.
- This installation task stops at the local origin. Do not configure a reverse proxy, Cloudflare Tunnel, VPN, Tailscale, firewall, DNS, public URL, `--host`, `--remote`, or `--trust-proxy` unless I make a separate, explicit external-ingress request.
- `--share` and `--cloudflared` are not StillOn features. If I later ask for access from another device, explain the local [external-ingress contract](external-ingress.md) and let me choose the operator-managed proxy, tunnel, or direct-listener approach; do not choose or administer it on my behalf.
- Do not expose secrets in shell history, logs, source files, or chat output.
- Treat provider tests and the first message as billable or quota-consuming work. Send them only after I explicitly approve.
<!-- prompt:end -->

External ingress is intentionally a separate step. After local installation and the chosen provider's first-use check work, the operator may connect an independently managed proxy, tunnel, or direct listener using the [external-ingress contract](external-ingress.md).

## What this prompt considers “done”

The coding agent is an installation and first-use guide, not a one-shot installer. A successful run has four observable outcomes: a named StillOn instance, a healthy local server, a ready chosen provider, and a first message sent with the user's approval. A separately requested external ingress has its own verification under the external-ingress contract.

After local verification, explain that LAN and Internet access are optional next steps, point to the external-ingress contract, and do not configure them automatically.
