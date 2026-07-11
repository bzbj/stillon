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

Your projects, credentials, processes, and chat history stay on your computer. StillOn provides the web workspace and secure connection path; it does not move agent execution into a hosted cloud.

> 电脑留在办公室，Agent 跟你走。

## Release status

StillOn is currently a **source-available public beta**. The supported launch scope is intentionally narrower than the long-term product:

| Platform | Status | Notes |
| --- | --- | --- |
| macOS 13+ | Primary | Main development and validation target |
| Linux | Beta | Core server works; desktop integrations vary by distribution |
| Windows | Planned | Not yet supported; terminal, process discovery, and path handling still need Windows validation |

The repository does not yet ship signed desktop installers. Install from source and review the [public-release readiness notes](docs/public-release-readiness.md) before exposing a machine outside your own network.

## Quickstart

Install [Bun](https://bun.sh) v1.3.5 or newer, then:

```bash
git clone https://github.com/bzbj/stillon.git
cd stillon
bun install
bun run build
bun run start
```

Open [localhost:3210](http://localhost:3210). A working Claude Code login is required for Claude sessions; Codex CLI is optional.

To install the command globally from this checkout:

```bash
bun install -g .
stillon
```

The legacy `husky` and `kanna` commands remain as compatibility aliases.

## Why StillOn

- **Remote continuation** — reach the same local coding-agent workspace from a laptop, tablet, or phone
- **Local execution** — agents run against the projects and credentials already on your computer
- **Claude and Codex** — switch providers, models, reasoning effort, permissions, and plan mode per chat
- **Usage visibility** — view Codex and Claude Code plan limits when the authenticated CLI exposes them
- **Persistent sessions** — resume chats with event-backed history, snapshots, and hydrated tool results
- **Project workspace** — organize chats by project, inspect Git state, run terminals, preview local apps, and attach files
- **Remote-friendly security** — password-gated sessions and Cloudflare tunnel support

## Remote access

StillOn gives an authenticated remote user access to local projects, agent processes, file previews, Git operations, and terminals. Treat access as equivalent to granting control of your development account.

```bash
# Temporary public URL and terminal QR code
stillon --share --password '<strong-password>'

# Named Cloudflare Tunnel using its token
stillon --cloudflared '<tunnel-token>' --password '<strong-password>'

# LAN or Tailscale
stillon --remote --password '<strong-password>'
```

`--share` refuses to start without `--password`. For named tunnels, use both a StillOn password and Cloudflare Access. You can also choose a custom port with `--port 4000`. `--share` and `--cloudflared` cannot be combined with `--host` or `--remote`.

For a named Cloudflare Tunnel, route the public hostname to `http://localhost:3210` and leave WebSockets enabled. StillOn accepts attachments up to 100 MB; make sure Cloudflare's request-size limit for your plan is not lower than the file you upload.

## Development

```bash
bun run dev
bun run check
bun test
```

`bun run dev --port 3333` uses port 3333 for Vite and 3334 for the backend. Development mode also supports `--share`, `--cloudflared`, `--host`, and `--remote`.

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

The old `HUSKY_*` and `KANNA_*` environment variables continue to work where they had public equivalents. New configuration should use `STILLON_*`.

Set `STILLON_MACHINE_NAME` to choose the non-sensitive machine label shown in the UI—for example, `STILLON_MACHINE_NAME="Office Mac"`.

## Release editions

StillOn is the product name. Working-dog names are release editions, similar to capability tiers. The current release is **Husky**; the planned sequence is documented in the code and may evolve.

## Origin and license

StillOn is independently maintained at [bzbj/stillon](https://github.com/bzbj/stillon) and is not part of GitHub's Kanna fork network. It contains code derived from [Kanna](https://github.com/jakemor/kanna).

The original copyright and license terms—including the named exception in the upstream license—remain in [LICENSE](LICENSE). Because that exception excludes named parties, this project describes itself as **source-available**, not OSI-approved open source. Obtain legal advice before commercial redistribution.

See the [brand guide](docs/brand.md), [security policy](SECURITY.md), and [public-release readiness notes](docs/public-release-readiness.md).

## Contributing

Issues and pull requests are welcome at [bzbj/stillon](https://github.com/bzbj/stillon). Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.
