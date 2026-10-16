# Public-release readiness

StillOn **0.5.0 (Husky)** is a macOS-first, source-available public beta. This
page distinguishes implemented behavior and CI coverage from independent-user
acceptance and distribution readiness. Unsigned beta publication is currently intentional. A published source release does not mean
every platform or Connect customer-release gate has passed.

## Distribution tiers

1. **Public source beta:** source and export-viewer assets are published on
   GitHub. Source installations can use the opt-in managed source updater.
2. **Native development packages:** macOS Intel/Apple Silicon and Windows
   x64/ARM64 runtimes and installers are built and exercised on native runners.
   PR/development downloads stay in Actions with an expiration date; normal beta
   releases publish permanent unsigned installers plus prebuilt update manifests.
3. **Optional signed desktop publication:** requires platform signing, macOS
   notarization and acceptance using the actual signing configuration. Unsigned
   beta release publication does not depend on signing credentials. A source-only release
   publishes no desktop package update manifest or official signed installers.

See [desktop distribution](desktop-distribution.md),
[managed updates](managed-updates.md) and the [release procedure](releasing.md).
Linux server support does not imply a packaged Linux desktop installer.

## Platform matrix

| Capability | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Bun server and browser UI | Primary; Intel/ARM64 CI | Beta; x64 CI | Beta; x64/ARM64 CI |
| Provider discovery and sessions | Primary | Beta | CLI/shim and lifecycle fixtures; independent provider acceptance remains |
| Agent network settings | System proxy detection | GNOME detection; other desktops manual | User/WinHTTP detection; environment-dependent |
| Embedded terminal | Supported | Supported where Bun.Terminal is available | Unavailable; use an external terminal |
| Local file/editor opening | Supported | Desktop/distribution-dependent | Partial; depends on installed editors |
| Local HTTP process discovery | lsof / ps | lsof / ps | Not implemented |
| Local file-link parsing | Unix paths | Unix paths | Drive/UNC handling implemented; retain platform regression coverage |
| Native development installer | DMG for Intel/Apple Silicon | Not packaged | Setup EXE for x64/ARM64 |
| Background service | LaunchAgent | systemd user service | Task Scheduler with watchdog |
| Managed updates | Opt-in source and package paths | Opt-in source path | Source/package code and native runner recovery checks |

Native CI covers package integrity, service lifecycle, update/rollback,
install/uninstall and preservation of synthetic user data. Physical Windows on
Arm devices, interactive installation UX, trusted OS signatures and real
provider authentication need their own acceptance evidence. A passing runner
does not establish complete platform feature parity.

## Connect preview

Implemented: fresh six-digit email-code linking, device identity, outbound frp,
per-computer origins, per-tab selection, authorization leases, pause/unlink,
browser-family Logout, durable operation receipts and connection diagnostics.
Local loopback use remains accountless. The remote-access interface and email
flow use English. See [Connect](connect-remote-access.md) for the protocol,
packaging, configuration and recovery contract.

Automated integration uses two isolated computers and synthetic accounts/mail.
It exercises HTTP/WebSocket traffic, bounded streaming uploads/downloads,
authorization, revocation and file integrity. Controlled deployment and an owner
pilot provide additional evidence; they are not broad customer certification.
Independent platform/user trials, public/mobile networks, the full fault/abuse/
load matrix, a 12-hour soak and operational alert delivery remain release gates
for a customer service. Billing, custom customer domains and shared-host teams
are not part of 0.5.0.

## Security and operational boundaries

- Keep the accountless local origin on loopback and enforce its Host/Origin
  contract. Do not expose its raw port to the Internet.
- Connect uses a separate authorized local adapter. Account login alone does
  not grant access to an arbitrary computer. Keep device keys and cloud secrets
  outside immutable releases and public logs.
- The gateway terminates TLS and is trusted. This is not end-to-end encryption.
  Agent/model providers can receive context sent to them by the local agents.
- Remote access grants authority over local agent tasks and files. Only link
  owned computers and use trusted browsers. Remote dynamic localhost previews
  are disabled in this pilot; supported static previews are sandboxed.
- Self-managed ingress still requires its own TLS, access policy and trusted
  proxy configuration. The optional application password is an additional
  local barrier, not a complete public gateway policy.
- Operators own source-IP trust, rate limits, certificate renewal, monitoring,
  backup retention and recovery testing. Health/readiness probes do not prove
  email deliverability, disk-write capacity or every computer's availability.
- Prompt/file-based input for the legacy application password and broader
  security review remain separate improvements; do not advertise them as done.

## Privacy and repository hygiene

- Public code and fixtures use example users, paths, projects and hostnames.
- Screenshots use synthetic data or a generic machine label. Do not package
  private task outputs, credentials, account databases or device identities.
- Scan the release source and Git history for secrets before publication.
  Review synthetic-fixture exclusions explicitly and keep reports redacted.
- Older revisions can retain historical path/screenshot data. Rewriting public
  history requires a separate explicit owner decision.
- Keep user history, provider credentials, settings and appearance assets out
  of immutable runtime payloads. Updates preserve data and keep a verified
  rollback snapshot before switching; publication itself installs nothing.

## Legal and governance

The inherited license contains a named-party exclusion and is not described as
OSI-approved open source. Preserve attribution in source and distributions.
Maintain the security policy, contribution guide, CI and explicit release
procedure. PR titles/descriptions and release titles/notes must use English.
