<p align="center">
  <img src="assets/stillon-mark.svg" alt="StillOn" width="96" />
</p>

<h1 align="center">StillOn</h1>

<p align="center">
  <strong>Leave your Mac. Keep your agents.</strong><br />
  You go. Your Claude Code and Codex agents stay on.
</p>

<p align="center">
  <a href="https://github.com/bzbj/stillon"><img src="https://img.shields.io/badge/project-StillOn-60a5fa?style=flat&amp;labelColor=141a29" alt="StillOn" /></a>
  <img src="https://img.shields.io/badge/release-Husky-c9f3ff?style=flat&amp;labelColor=141a29" alt="Husky release" />
  <a href="https://github.com/jakemor/kanna"><img src="https://img.shields.io/badge/source-Kanna-8dd8ff?style=flat&amp;labelColor=141a29" alt="Derived from Kanna" /></a>
</p>

<br />

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot.png" />
    <source media="(prefers-color-scheme: light)" srcset="assets/screenshot-light.png" />
    <img src="assets/screenshot-light.png" alt="StillOn workspace" width="800" />
  </picture>
</p>

StillOn turns an always-on Mac into a personal agent outpost. Leave the computer at home or in the office, then reconnect from an iPad, phone, or browser to continue local Claude Code and Codex sessions.

Your projects, credentials, processes, and chat history stay on your computer. StillOn provides the web workspace and local origin; an operator chooses and manages any external connection path. It does not move agent execution into a hosted cloud.

> Leave your computer. Agent Still On.

## Release status

StillOn is currently a **source-available public beta**. The supported launch scope is intentionally narrower than the long-term product:

| Platform | Status | Notes |
| --- | --- | --- |
| macOS 13+ | Primary | Main development and validation target |
| Linux | Beta | Core server works; desktop integrations vary by distribution |
| Windows 10/11 | Beta | Validated with PowerShell, Git, x64/ARM64 Bun, and Task Scheduler services |

The repository does not yet ship signed desktop installers. Install from source and review the [public-release readiness notes](docs/public-release-readiness.md) before exposing a machine outside your own network.
Versioned releases are explicit GitHub source releases; see the [release guide](docs/releasing.md).

## Before you install

StillOn is the browser workspace around your local coding agents; it is not an
AI provider, account manager, VPN, power manager, or public tunnel. It assumes
that the provider layer already works for the same operating system user that
will run StillOn.

Before installing StillOn:

- install [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and/or
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started),
  and make the commands available on `PATH`;
- launch every CLI you intend to use directly from a terminal and finish its
  authentication flow;
- verify that the required subscription, workspace entitlement, API billing,
  or enterprise provider access is active; and
- provide any outbound route those CLIs need, such as a system VPN, corporate
  gateway, or local HTTP/SOCKS proxy; see
  [agent egress](docs/production-runtime.md#agent-egress-system-vpn-and-local-proxy).

A working Claude Code login is required for Claude sessions, and a working
Codex login is required for Codex sessions. Install and verify both CLIs for the
full dual-provider experience; if you only use one provider, only that
provider's CLI is required. StillOn does not create provider accounts, purchase
plans, resolve regional availability, or start and reconnect a VPN for you.

The full operating chain looks like this:

| Layer | Operator responsibility |
| --- | --- |
| Agent provider | Working Codex/Claude Code CLI, authentication, account or API billing, and outbound network access |
| Local workspace | StillOn built and healthy at `http://127.0.0.1:3210` |
| Process lifetime | StillOn's native per-user service enabled and verified for the host platform |
| Host availability | Power connected as appropriate, system sleep disabled, and network kept online |
| External ingress | A deliberately chosen private network, tunnel, proxy, TLS, and access policy |
| Remote client | A trusted browser that can reach the selected ingress |

## Quickstart

Install [Bun](https://bun.sh) v1.3.5 or newer, then:

```bash
git clone https://github.com/bzbj/stillon.git
cd stillon
bun install
bun run build
bun run start
```

Open [localhost:3210](http://localhost:3210). This confirms local access only.
StillOn needs a working, authenticated CLI for each provider you enable, as
described above.

To install the command globally from this checkout:

```bash
bun install -g .
stillon
```

The supported command is `stillon`. Existing `kanna` launchers should be
replaced rather than kept as aliases; this avoids accidentally starting a
previous application after a migration.

## Turn local access into remote access

A successful installation intentionally stops at
`http://127.0.0.1:3210`. Reaching StillOn from another computer, phone, or
tablet requires **all three** of the following layers.

### 1. Keep the StillOn process running

Use StillOn's native per-user service. PM2 or a second process manager is not
needed for the standard installation:

```bash
stillon service install
stillon service status
```

The integration uses a LaunchAgent on macOS, a systemd user service on Linux,
and a Task Scheduler task on Windows. It starts with the user session and has
platform-appropriate restart behavior after an unexpected exit. Running two
supervisors at once can instead create port conflicts. See
[Background service](#background-service) for status, logs, uninstall, Linux
linger, fixed-port, and service environment-file details.

### 2. Keep the host awake and online

Connect a laptop to power when appropriate, let the display turn off, but
configure the operating system so the computer itself does not sleep. Also
check what closing the laptop lid does on the specific machine.

- **macOS:** Prefer Apple's **System Settings → Battery → Options → Prevent
  automatic sleeping on power adapter when the display is off**. For more
  flexible manual sessions or triggers, [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704)
  is a useful optional helper. Test closed-display behavior on the actual Mac;
  power, peripherals, macOS version, and thermal conditions can affect it.
- **Windows:** For unattended use, configure **Settings → System → Power &
  battery → Screen, sleep & hibernate timeouts**, and review the lid-close
  action. [PowerToys Awake](https://learn.microsoft.com/windows/powertoys/awake)
  is convenient for temporary sessions, but Microsoft documents that it only
  works while a user is signed in and does not keep the PC awake at the lock
  screen. Do not use Awake as the only power policy for an unattended host.

Preventing sleep increases power use. Keep the machine ventilated, locked, and
physically secure.

### 3. Choose a secure external ingress

Do not forward port `3210` directly from a home router or cloud firewall to the
public Internet. Remote StillOn access effectively grants development-account
level access to local files, Git, terminals, and agent processes.

For personal use, the recommended path is
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve):

1. Install Tailscale on the StillOn host and each client, then restrict access
   through the tailnet's users, devices, and grants/ACLs.
2. Keep StillOn on `127.0.0.1`, install its service with `--trust-proxy`, and
   proxy the loopback origin through Tailscale Serve:

   ```bash
   stillon service install --trust-proxy
   tailscale serve --bg http://127.0.0.1:3210
   ```

3. Use the private HTTPS URL reported by Tailscale and verify both normal HTTP
   navigation and an active StillOn chat from the remote device.

For a stable hostname on your own domain or access beyond a single tailnet, use
[Cloudflare Tunnel with a self-hosted Cloudflare Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/):

1. Create the Access application and a narrow allow policy **before**
   publishing the tunnel hostname.
2. Run `cloudflared` independently and route the hostname to
   `http://127.0.0.1:3210`; keep StillOn on loopback and install its service
   with `--trust-proxy`.
3. Confirm the proxy preserves the public `Host`, sends
   `X-Forwarded-Proto: https`, and supports WebSocket upgrades for `/ws`.

Cloudflare Tunnel broadens reach; it does not turn StillOn into a general
multi-user service. Keep access limited to people who should have control of
the host's development account. StillOn's optional `--password` is a local
convenience barrier, not a replacement for Tailscale policy or Cloudflare
Access.

Installation agents must prioritize a local-only installation and verify that
the user can open `http://127.0.0.1:3210`. Once that succeeds, the installation
task is complete. The agent may then explain process supervision, power
settings, and external-access options as optional follow-up work, but it must
not treat an installation request as permission to configure any of them.

The user decides whether follow-up work is wanted, which approach to use, and
whether an agent should help implement it. Unless the user makes a separate,
explicit request, leave process supervision, power settings, VPN/proxy
configuration, DNS, and external ingress unchanged. If external access is
requested later, see [External ingress](docs/external-ingress.md) for the exact
proxy and security contract.

## Windows

StillOn supports Windows 10/11 with Bun 1.3.5 or newer, Git, and PowerShell.
Install and validate from PowerShell:

```powershell
git clone https://github.com/bzbj/stillon.git
cd stillon
bun install --frozen-lockfile
bun run check
bun run test
bun run start -- --no-open
```

The server listens on `http://127.0.0.1:3210` by default. Codex and Claude
Code should be installed for the current Windows user and available on `PATH`;
StillOn resolves their `.cmd` shims on Windows. The optional background service
uses Task Scheduler and starts at sign-in.

Windows terminal sessions use the configured local shell. Unix-specific PTY
signals do not have direct Windows equivalents, so advanced terminal signal
handling has narrower automated coverage than macOS and Linux.

## Background service

After installing the `stillon` command globally, you can opt in to a native
per-user background service:

```bash
stillon service install
stillon service status
stillon service logs
stillon service uninstall
```

Use `stillon service install --port 4000` to choose a fixed port. Pass
`--env-file /absolute/path/to/stillon.env` to load a dedicated service-only
environment file. This is the supported way to persist a local proxy
configuration for Codex and Claude Code without copying the caller's whole
shell environment; see [agent egress](docs/production-runtime.md#agent-egress-system-vpn-and-local-proxy).
Managed
services always start with `--no-open` and `--strict-port`, so a port conflict
is reported instead of silently moving StillOn to a different address.

For an isolated, rollback-friendly production installation, follow
[Production runtime installs](docs/production-runtime.md). The service uses
the runtime directory that contains its `bin/stillon` entrypoint as its
working directory, rather than the directory from which `service install` was
run.

| Platform | Native integration | Lifecycle |
| --- | --- | --- |
| macOS | Per-user LaunchAgent | Starts at login and is kept alive by `launchd` |
| Linux | systemd user service | Starts with the user manager and restarts after exit |
| Windows | Per-user Task Scheduler task | Starts at sign-in with bounded failure retries |

On Linux, a user service normally stops when the user manager exits. To keep it
running after logout and start the user manager at boot, an administrator can
enable lingering for that account:

```bash
sudo loginctl enable-linger "$USER"
```

The service integration defaults to the normal loopback address and does not
store passwords or provision a tunnel. It can persist `--host`, `--remote`,
and `--trust-proxy` when an operator manages the external entrypoint; see
[External ingress](docs/external-ingress.md). Removing the service does not
remove projects or data under `~/.stillon/`.

Windows service management is included for forward compatibility, but the
broader Windows runtime remains planned rather than supported in this beta.

## Why StillOn

- **Remote continuation** — reach the same local coding-agent workspace from a laptop, tablet, or phone
- **Local execution** — agents run against the projects and credentials already on your computer
- **Claude and Codex** — switch providers, models, reasoning effort, permissions, and plan mode per chat
- **Usage visibility** — view Codex and Claude Code plan limits when the authenticated CLI exposes them
- **Persistent sessions** — resume chats with event-backed history, snapshots, and hydrated tool results
- **Project workspace** — organize chats by project, inspect Git state, run terminals, preview local apps, and attach files
- **Operator-managed ingress** — keep the local origin on loopback or connect it through your own proxy, tunnel, or network listener

## Remote access

StillOn gives an authenticated remote user access to local projects, agent
processes, file previews, Git operations, and terminals. Treat that access as
equivalent to granting control of your development account.

StillOn starts on `127.0.0.1` by default. It does not create a public URL,
Cloudflare Tunnel, or other external route. You may run a Cloudflare Tunnel,
another tunnel, a reverse proxy, or a direct network listener independently;
StillOn's supported local contract is documented in
[External ingress](docs/external-ingress.md). Use `--trust-proxy` only when a
trusted proxy is the sole route to the local origin.

## Development

```bash
bun run dev
bun run check
bun test
```

`bun run dev --port 3333` uses port 3333 for Vite and 3334 for the backend. Development mode supports explicit `--host`, `--remote`, and `--trust-proxy`; its default listener stays on loopback.

## Architecture

```text
Browser / iPad / phone
        ↕ HTTP + WebSocket
StillOn Bun server on your computer
        ├── project and chat event store
        ├── terminal, Git, uploads, and local previews
        └── Claude Agent SDK / Codex App Server
                         ↕
                Local projects and tools
```

StillOn uses React and Zustand in the browser, a Bun HTTP/WebSocket server, append-only JSONL event logs, and compacted snapshots.

## Local data and migration

New state is stored under `~/.stillon/`; per-project uploads, exports, and quick actions use `.stillon/` inside the project.

On first launch, StillOn automatically renames an existing `~/.kanna/` data root to `~/.stillon/`. Existing project attachments and quick actions under `.kanna/` remain readable, while new files use `.stillon/`.

Runtime configuration uses `STILLON_*` variables. Legacy `KANNA_*` variables
and the `kanna` command are not read by StillOn. Data migration is isolated to
the documented data roots above, so importing old history does not reactivate
old launch configuration.

Choose a non-sensitive machine label in **Settings → General → Machine Name**; it is shown in the sidebar and browser tab so remote sessions are easy to identify. `STILLON_MACHINE_NAME` remains supported as the initial default—for example, `STILLON_MACHINE_NAME="Office Mac"`.

## Release editions

StillOn is the product name. Working-dog names describe long product-maturity
eras rather than individual patch or minor releases. The prototype period is
retrospectively **Pup**, the entire `0.x` public-beta line is **Husky**, and
**Corgi** begins when StillOn reaches the stable `1.0` contract.

See the [release roadmap](docs/roadmap.md) for the graduation gates, the
reserved edition sequence, and the origin of the names.

## Origin and license

StillOn is independently maintained at [bzbj/stillon](https://github.com/bzbj/stillon) and is not part of GitHub's Kanna fork network. It contains code derived from [Kanna](https://github.com/jakemor/kanna).

The original copyright and license terms—including the named exception in the upstream license—remain in [LICENSE](LICENSE). Because that exception excludes named parties, this project describes itself as **source-available**, not OSI-approved open source. Obtain legal advice before commercial redistribution.

See the [brand guide](docs/brand.md), [security policy](SECURITY.md), and [public-release readiness notes](docs/public-release-readiness.md).

## Contributing

Issues and pull requests are welcome at [bzbj/stillon](https://github.com/bzbj/stillon). Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.
