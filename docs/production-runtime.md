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
checkout. It is the appropriate place for configuration such as a trusted
reverse proxy or a machine label. Do not put passwords or tunnel tokens in a
native service configuration.

```bash
mkdir -p "$HOME/.config/stillon"
${EDITOR:-vi} "$HOME/.config/stillon/production.env"
```

For example:

```dotenv
STILLON_TRUST_PROXY=1
STILLON_MACHINE_NAME=Office Mac
```

Install the native service by invoking the entrypoint in this runtime:

```bash
"$RUNTIME_ROOT/bin/stillon" service install \
  --port 3210 \
  --env-file "$HOME/.config/stillon/production.env"
```

The installation records the runtime root as the service working directory.
It also loads the given environment file through Bun before StillOn begins, so
it does not accidentally inherit a `.env` file from an unrelated checkout.
Ensure the service PATH includes the command-line agents you intend StillOn to
run (for example `codex`, `claude`, and `opencode`).

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
