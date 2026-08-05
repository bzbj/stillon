# Public-release readiness

StillOn is a **macOS-first, source-available public beta**, not a finished
cross-platform consumer application. This document records the validated
baseline and the remaining gates; it should be updated whenever a release
changes a platform or security claim.

## Release tiers

1. **GitHub source beta (current)** — developers clone the repository and run it with Bun.
2. **Packaged beta** — signed and notarized artifacts, checksums, release notes, and an upgrade path.
3. **Cross-platform release** — tested installers and an explicit feature-parity contract for every supported platform.

## Privacy and repository hygiene

- Current source and fixtures must use example users, paths, projects, and hostnames.
- Public screenshots must use a generic machine label through **STILLON_MACHINE_NAME**.
- Unused personal-brand assets must not ship.
- The current Git history still contains earlier path and screenshot data. Rewriting public history or recreating the repository requires an explicit owner decision.
- Run secret scanning over the full history before every public release.

## Platform matrix

| Capability | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Bun server and browser UI | Primary | Beta | Beta; native CI passes |
| Claude/Codex discovery and sessions | Primary | Beta | Beta; Codex startup manually validated, full Claude lifecycle pending |
| Agent network settings | System proxy detection | GNOME detection; other desktops manual | User/WinHTTP detection manually validated |
| Embedded terminal | Primary | Beta | Not available |
| Open file/editor | Primary | Distribution-dependent | Partial implementation |
| Local HTTP process discovery | lsof / ps | lsof / ps | Not implemented |
| Local file-link parsing | Unix paths | Unix paths | Drive, UNC, and percent-encoded backslash handling implemented |
| Installer | Not packaged | Not packaged | Not packaged |
| Background auto-start | CLI-managed LaunchAgent | CLI-managed systemd user service | CLI-managed Task Scheduler integration; runtime beta |

Bun itself provides Windows ConPTY support, so the embedded-terminal gap is
StillOn integration work rather than a runtime rewrite.

The `v0.2.5` baseline passes CI on macOS, Ubuntu, and Windows, plus CodeQL and
the high-severity dependency audit. Windows manual acceptance covered system
proxy detection, redacted Claude/Codex endpoint diagnostics, a real Codex
session, agent restart behavior, and percent-encoded drive-link click-through.
A real Claude session was not exercised on that host because its OAuth session
had expired. Passing native CI establishes portability, not feature parity.

## Security gates

- Keep localhost as the default bind address.
- Keep tunnel, DNS, TLS, and edge authentication lifecycle outside the product.
- For external ingress, document and test the trusted-proxy contract: preserved `Host`, `X-Forwarded-Proto`, WebSocket upgrades, and origin isolation.
- Treat the optional application password as a convenience barrier; require an appropriate operator-managed authentication policy for Internet-facing access.
- Rate-limit login attempts and never forward session/auth headers into previewed local services.
- Document that authenticated users receive development-account-level authority.
- Add prompt/file-based password input so secrets do not need to appear in process arguments.
- Add aggregate request limits or streaming uploads before accepting untrusted large files.
- Review local-file and browser-preview capabilities as part of the single-user threat model.

## Distribution and operations

- Keep the public source-beta distribution model explicit and do not add an
  in-app updater without a verified update and rollback design. Revisit npm,
  standalone binaries, or a desktop wrapper only if the distribution model changes.
- For macOS packaging, add code signing, notarization, checksums, and a verified update channel.
- Add Linux packages only after testing shell, desktop opener, lsof, and the
  CLI-managed systemd user-service integration across target distributions.
- Do not describe Windows as feature-complete until embedded terminal and
  process discovery are implemented and the Claude/Codex lifecycle matrix is
  manually accepted.
- Publish a rollback procedure and data-format compatibility policy.

## Legal and governance

The inherited license contains a named-party exclusion. That means GitHub correctly detects it as “Other,” and the project should not market itself as OSI-approved open source without legal review or upstream relicensing. Preserve attribution in every distribution.

Before accepting outside contributions, keep a security policy, contribution guide, CI, dependency update automation, and documented release process. A CLA or DCO is optional but should be chosen before substantial external contributions.
