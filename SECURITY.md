# StillOn security

StillOn deliberately connects a browser to powerful tools on a local computer. Anyone who can authenticate can interact with projects, agents, Git, file previews, local development servers, and terminals. StillOn is a single-user tool; it is not a multi-tenant authorization boundary.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private security advisory form](https://github.com/bzbj/stillon/security/advisories/new) and include:

- affected version or commit;
- reproduction steps;
- expected impact;
- any suggested mitigation.

## Safe deployment

- Keep the default **127.0.0.1** binding unless remote access is intentional.
- The **--share** option requires **--password**; use a unique, high-entropy password.
- For a named Cloudflare Tunnel, combine a StillOn password with Cloudflare Access.
- Do not expose the origin port directly to the public internet.
- Treat every authenticated browser as having the same authority as the local development user.
- Review transcript exports before sharing; they can contain prompts, code, tool output, and file metadata.
- Keep Bun, Claude Code, Codex, cloudflared, and project dependencies patched.

Passwords and tunnel tokens passed as command-line arguments can appear in shell history or local process inspection. A prompt/file-based secret input is tracked as a release-hardening item; until then, avoid shared machines and clear sensitive command history.

## Security design

- Session tokens are random, in-memory, HttpOnly, SameSite=Strict, and marked Secure behind trusted HTTPS proxies.
- State-changing authentication requests and WebSocket upgrades validate their origin.
- Failed password attempts are rate limited.
- Browser preview proxying strips StillOn cookies, authorization data, forwarding metadata, and upstream Set-Cookie headers.
- New analytics installations are disabled unless explicitly enabled, and no analytics endpoint is configured by default.

The detailed threat model and remaining release work are in [docs/public-release-readiness.md](docs/public-release-readiness.md).
