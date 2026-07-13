# Production runtime installs

Keep a production runtime separate from the checkout where you develop
StillOn. The runtime owns the deployed code, build artifacts, service
configuration, and logs; your development checkout remains safe to edit.

## Install a pinned runtime

Choose a revision or release tag, then prepare a dedicated directory. Do not
point a background service at a development checkout.

```bash
export RUNTIME_ROOT="$HOME/.local/share/stillon/releases/2026-07-12"
git clone https://github.com/bzbj/stillon.git "$RUNTIME_ROOT"
git -C "$RUNTIME_ROOT" checkout <revision-or-tag>
cd "$RUNTIME_ROOT"
bun install --frozen-lockfile
bun run build
```

Create a service environment file outside both the runtime and source
checkout. It is the appropriate place for explicit StillOn configuration and
agent egress settings, such as a machine label or local proxy. It is not a
copy of the shell environment that happened to run `service install`.

```bash
mkdir -p "$HOME/.config/stillon"
${EDITOR:-vi} "$HOME/.config/stillon/production.env"
```

For example:

```dotenv
STILLON_MACHINE_NAME=Office Mac
```

Install the native service by invoking the entrypoint in this runtime:

```bash
"$RUNTIME_ROOT/bin/stillon" service install \
  --port 3210 \
  --trust-proxy \
  --env-file "$HOME/.config/stillon/production.env"
```

The installation records the runtime root as the service working directory.
It also loads the given environment file through Bun before StillOn begins, so
it does not accidentally inherit a `.env` file from an unrelated checkout.
Ensure the service PATH includes the command-line agents you intend StillOn to
run (for example `codex`, `claude`, and `opencode`).

Keep the service on loopback when an independently managed proxy or tunnel
runs on the same machine. See [External ingress](external-ingress.md) for the
required `Host`, forwarding, and WebSocket contract; StillOn does not create
or configure the external entrypoint.

## Agent egress: system VPN and local proxy

This section concerns **outbound** connectivity from StillOn's Codex and
Claude Code processes to their providers. It does not expose StillOn to a
phone or browser; that remains the separate [external-ingress](external-ingress.md)
contract.

If an already connected system VPN supplies the required network route, no
StillOn setting is needed: the background service uses the operating system's
network stack. StillOn does not start, reconnect, or monitor a VPN.

If the machine instead needs a local HTTP or SOCKS proxy, put the proxy
variables in the dedicated service environment file. For example, for an HTTP
CONNECT proxy:

```dotenv
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
```

For a SOCKS proxy, use `ALL_PROXY` only when the selected CLI and proxy support
that URI scheme, for example:

```dotenv
ALL_PROXY=socks5://127.0.0.1:1080
NO_PROXY=localhost,127.0.0.1,::1
```

`stillon service install --env-file <absolute-path>` validates that file and
records its absolute path in the native service invocation. On every service
start Bun loads it before StillOn begins, and StillOn passes the resulting
environment to Codex and Claude Code. It deliberately does **not** persist the
entire environment of the shell that performed the installation.

Use a file readable only by the account that runs the service, especially if a
proxy URL includes credentials. After editing it, rerun the same `service
install --env-file …` command to restart the service with the new settings.

## Verify, update, and roll back

Check the native service and local health endpoint after each deployment:

```bash
"$RUNTIME_ROOT/bin/stillon" service status
curl --fail http://127.0.0.1:3210/health
```

For an update, create and build a new release directory, verify it manually
on an unused local port, then run `service install` from its `bin/stillon`
entrypoint. The per-user service is replaced with the new runtime. StillOn
does not download or install releases itself; **Settings → Changelog** can
generate a source-upgrade prompt for Codex or Claude Code instead.

To roll back, reinstall the service from the known-good release directory:

```bash
"$KNOWN_GOOD_RUNTIME/bin/stillon" service install \
  --port 3210 \
  --env-file "$HOME/.config/stillon/production.env"
```

The user data directory (`~/.stillon/`) is deliberately outside every
runtime release directory, so upgrades and rollbacks retain the same history.
StillOn can migrate a prior `~/.kanna/` data root on first launch, but it never
uses Kanna's command or environment variables after the data migration.
