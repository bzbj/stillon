# CodeBuddy CLI optional integration (preview)

This package connects StillOn to a separately installed **public CodeBuddy CLI**.
Codex and Claude Code stay built into StillOn. Neither the CodeBuddy CLI nor the
182 MB Agent SDK runtime is included in StillOn or this adapter package.

The development StillOn build includes this adapter, disabled by default. Open
**Settings -> Integrations -> CodeBuddy CLI (Preview) -> Enable**. It updates
with StillOn and preserves its enabled flag and chat history across restarts.
Previous official installers require a main-app upgrade to gain this capability;
no production release has been made. For standalone protocol fixtures, use
`bun scripts/build-provider-addon.ts codebuddy` to produce the development package.

## Local CLI and configuration

Install and sign in using the [official CLI instructions](https://www.codebuddy.ai/docs/cli/quickstart).
The adapter searches `codebuddy`, `cbc`, and `codebuddy-code` on PATH, then public
user launcher directories. Settings -> Providers -> CodeBuddy -> Use an existing
CLI selects a launcher explicitly (`CODEBUDDY_EXECUTABLE` also works). An invalid
explicit selection reports an error instead of silently selecting another CLI.
Windows npm `.cmd` shims and paths containing spaces are supported.

WorkBuddy Desktop is a separate product. This adapter does not extract its
private bundled runtime or copy its account credentials. Users manage CLI
installation, sign-in, endpoint, model, and updates outside StillOn.

The preview targets **Windows x64 and macOS Intel / Apple Silicon**, with public
**CodeBuddy CLI 2.180.0**. Unknown CLI
versions fail with a compatibility message. Qualify a new version and publish a
new adapter after a vendor update; do not assume compatible flags imply a
compatible protocol. Other platforms are not advertised by the manifest.

For the pinned macOS preview, install Node.js 24 and run:

```sh
npm install -g @tencent-ai/codebuddy-code@2.180.0
codebuddy --version
```

Sign in and choose the model/endpoint in the public CLI. A compatible native or
Homebrew launcher can also be selected through **Configure → Use an existing CLI**.
StillOn searches PATH, public user launcher directories, `/usr/local/bin` and
`/opt/homebrew/bin`; it never uses WorkBuddy's private runtime.

## Invocation and behavior

The adapter invokes the public CLI using `--print`, `--input-format=stream-json`,
`--output-format=stream-json`, and `--verbose`. It performs an `initialize`
handshake before sending a user frame, and uses `--resume` for existing sessions.
The working directory is the StillOn workspace; `--setting-sources
user,project,local` retains normal CLI settings and instruction discovery.
The CLI's own instruction rules apply; this preview has not qualified its
AGENTS.md precedence through authenticated inference.

The first model choice is **CLI default**. StillOn omits `--model` and `--effort`
so it does not invent model availability or override the user's vendor setup.
“Ask for approval” uses native `default` permission mode and forwards requests
to StillOn. Dismissal denies the operation. Explicit “Full access” uses native
`bypassPermissions`. These are CLI policies, not a StillOn OS sandbox guarantee.

Only visible assistant text, tools, results and session identity are forwarded.
Raw initialization responses and stderr are never exposed: initialization may
contain account tokens. Native tool approvals and AskUserQuestion use the host's
existing interaction channel. Background task notifications are tracked before
finishing. Stop sends `interrupt`, closes stdin and confirms process exit;
process-tree termination is a bounded fallback. CLI auto-update is disabled only
inside owned turns so an update cannot replace their transport mid-request.

## Verification and remaining qualification

- Public CLI 2.180.0: real `--version`, `--help`, initialization handshake and
  process exit checked in a fresh, unsigned-in home on Windows x64.
- Separately built package: process-backed protocol fixtures cover workspace
  selection, resume, approvals/denials, question answers, background completion,
  Stop, and coexistence with independently disabled/reinstalled DeepSeek.
- Browser: both package imports, missing-public-CLI status, independent disable,
  uninstall/reinstall, and saved permission settings after reload checked in the
  isolated development preview. Installed adapter availability is distinct from CLI
  installation and account readiness.
- macOS acceptance runs the real public CLI with isolated configuration and a
  loopback model endpoint. It checks actual session resume, file reading, host
  questions and cancellation on both Mac architectures in CI. Run
  `bun scripts/verify-macos-integrations.ts --run` after installing the pinned CLIs
  under `test-artifacts/macos-cli`.
- **Vendor-account inference and packaged-desktop replacement/upgrades remain
  unqualified.** Loopback endpoint acceptance does not validate a vendor account.

Run `bun test src/server/codebuddy-harness.test.ts`. Start an empty, isolated
two-provider preview with `bun scripts/dev-provider-addons.ts` (port 3218), then
import each package through the UI. This does not modify the installed service.

Protocol references: [headless CLI](https://www.codebuddy.ai/docs/cli/headless),
[permissions and question answers](https://www.codebuddy.ai/docs/cli/sdk-permissions),
[stdio task lifecycle](https://www.codebuddy.ai/docs/cli/workflow-stdio-protocol),
and the published `@tencent-ai/agent-sdk@0.3.300` transport/controller interface.
