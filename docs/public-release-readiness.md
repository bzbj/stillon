# Public-release readiness

StillOn's first public release should be treated as a **macOS-first, source-available beta**, not a finished cross-platform consumer application.

## Release tiers

1. **GitHub source beta** — developers clone the repository and run it with Bun.
2. **Packaged beta** — signed and notarized macOS artifacts, checksums, release notes, and an upgrade path.
3. **Cross-platform release** — tested installers and feature parity targets for macOS, Linux, and Windows.

## Privacy and repository hygiene

- Current source and fixtures must use example users, paths, projects, and hostnames.
- Public screenshots must use a generic machine label through **STILLON_MACHINE_NAME**.
- Unused personal-brand assets must not ship.
- The current Git history still contains earlier path and screenshot data. Rewriting public history or recreating the repository requires an explicit owner decision.
- Run secret scanning over the full history before every public release.

## Platform matrix

| Capability | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Bun server and browser UI | Primary | Beta | Needs CI validation |
| Claude/Codex discovery | Primary | Beta | Needs path and CLI validation |
| Embedded terminal | Primary | Beta | Disabled in current app code |
| Open file/editor | Primary | Distribution-dependent | Partial implementation |
| Local HTTP process discovery | lsof / ps | lsof / ps | Not implemented |
| Local file-link parsing | Unix paths | Unix paths | Drive/UNC paths incomplete |
| Installer | Not packaged | Not packaged | Not packaged |
| Background auto-start | CLI-managed LaunchAgent | CLI-managed systemd user service | CLI-managed scheduled task; runtime experimental |

Bun itself now provides Windows ConPTY support, so Windows work is primarily StillOn integration, path handling, process discovery, provider CLI validation, and CI—not a runtime rewrite.

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

- Keep source-only releases private and do not add an in-app updater. Revisit npm,
  standalone binaries, or a desktop wrapper only if the distribution model changes.
- For macOS packaging, add code signing, notarization, checksums, and a verified update channel.
- Add Linux packages only after testing shell, desktop opener, lsof, and the
  CLI-managed systemd user-service integration across target distributions.
- Add Windows only after a native Windows CI job passes and embedded terminal/process discovery blockers are removed.
- Publish a rollback procedure and data-format compatibility policy.

## Legal and governance

The inherited license contains a named-party exclusion. That means GitHub correctly detects it as “Other,” and the project should not market itself as OSI-approved open source without legal review or upstream relicensing. Preserve attribution in every distribution.

Before accepting outside contributions, keep a security policy, contribution guide, CI, dependency update automation, and documented release process. A CLA or DCO is optional but should be chosen before substantial external contributions.
