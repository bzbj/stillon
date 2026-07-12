# Install and configure StillOn with your coding agent

StillOn is designed for people who already work with Codex or Claude Code. Copy the prompt below into your coding agent. It will install StillOn from its official source repository, then guide the access setup that fits your situation and your first message.

<!-- prompt:start -->
Install StillOn from its official source repository and complete first-use setup:
https://github.com/bzbj/stillon

Act as my installation and first-use guide. Do not treat a running service as “done”: make local use work first, configure the access path that fits my situation, then help me send my first message in StillOn.

Before making changes, ask these three short questions:
1. What should this instance’s **Machine Name** be?
2. Do I want to use Codex, Claude Code, or both first?
3. After installation, how do I want to access it: A. only on this computer; B. on the same LAN; or C. over the internet?

If I have not chosen an access path yet, complete A first, then explicitly ask whether I want to continue with B or C. Do not guess for me or assume that I want network exposure.

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
7. After local verification, guide me through the access path I chose:
   - **A. This computer only:** Keep the `127.0.0.1` binding, give me the precise URL, and wait for me to confirm that it opens in a browser.
   - **B. Same LAN:** First explain that devices on the same network may reach this computer's projects, terminal, and agents. After explicit consent, use the documented `--remote` plus strong-password launch method, find this computer's LAN IPv4 address, and give me the exact `http://LAN-IP:port` URL. Verify the listener locally, then ask me to open it from another device. Do not change a firewall, router, or Tailscale without confirmation; if one blocks access, explain why and the safe next step.
   - **C. Internet access:** Continue only after I explicitly choose it. Explain that this gives a remote browser control over local projects, terminals, and agents, and requires both a StillOn password and Cloudflare Access. Guide me to register or sign in to my own Cloudflare account, prepare a domain that is active in Cloudflare, then create a remotely managed Tunnel and public hostname in the Cloudflare Dashboard that routes to `http://localhost:3210`. Next create a Cloudflare Access self-hosted application and an allow policy only for me. Do not use `--remote`, expose the origin port, or automatically use a temporary `--share` tunnel unless I explicitly ask for a temporary public URL.
   - For C, only after I have entered a Tunnel token safely on the local computer, use the repository's documented `--cloudflared <token>` plus StillOn-password launch path. Do not ask me to paste passwords, Tunnel tokens, Cloudflare credentials, or verification codes into chat, and do not put them in shell history, logs, source files, or configuration files. If this tool cannot receive a secret without exposing it, stop at that point and tell me how to enter it safely on the computer.
   - After external setup, verify the public hostname and Cloudflare Access from a separate browser or device. A running local process alone is not a successful external setup.
8. Once the selected access path works, guide my first message:
   - Create a new StillOn conversation with my chosen provider. Before sending a provider message, show me the proposed text and ask for confirmation because it may use quota or cost money.
   - If I do not yet have a task, suggest this harmless opener: `Please confirm that I am connected to StillOn. Do not modify files or run commands; in one sentence, tell me how you can help me here.`
   - If you can interact with the browser, send it in StillOn and confirm a reply arrives. If you cannot, give me the exact click path and wait for my result. If there is no reply, state the specific blocker and safe next action; do not claim first-use setup is complete.
9. If this installation replaces Kanna, keep Kanna and its data untouched until StillOn has passed the local health check and the first-use check for my chosen provider. Only then offer a separately confirmed cutover or shutdown; Kanna must never be StillOn's runtime dependency.
10. Offer the optional per-user background service only after explaining its effect and receiving confirmation.

Safety constraints:
- Keep StillOn bound to `127.0.0.1` by default. Any network exposure must be selected and confirmed by me step by step.
- Before any privileged or destructive action, firewall/DNS/existing-service change, or Cloudflare resource creation, explain the impact and ask for confirmation.
- Do not rely on a single layer for internet access: a named Cloudflare Tunnel needs Cloudflare Access, and StillOn needs a strong password. Never expose the origin port directly.
- Do not expose secrets in shell history, logs, source files, or chat output.
- Treat provider tests and the first message as billable or quota-consuming work. Send them only after I explicitly approve.
<!-- prompt:end -->

## What this prompt considers “done”

The coding agent is an installation and first-use guide, not a one-shot installer. A successful run has five observable outcomes: a named StillOn instance, a healthy local server, a ready chosen provider, a verified chosen access path, and a first message sent with the user's approval.

Even when the user only needs local access, explain after local verification that LAN and internet access are optional next steps. Only configure them if the user chooses them.
