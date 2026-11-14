# Managed updates

Managed updates replace the normal two-agent upgrade workflow with a persistent,
independent updater. Source installations build releases locally. Desktop package installations download
prebuilt official runtime archives, verify them and reuse prepared candidates. See
[desktop distribution](desktop-distribution.md) for the package/signing contract.
Neither path requires Python.

## Platforms

| Installation | Bun architecture | Updater owner |
| --- | --- | --- |
| Intel Mac | x64 | Separate user LaunchAgent |
| Apple Silicon Mac | arm64 | Separate user LaunchAgent |
| Windows PC / Intel Surface | x64 | Separate user scheduled task |
| Windows on Arm / Arm Surface | arm64 | Separate user scheduled task |

The service's **Bun executable architecture** determines native dependencies.
An x64 Bun running under emulation keeps x64 dependencies; it is never silently
switched to arm64 based on a device name. Each prepared source release gets a fresh
`bun install --frozen-lockfile`; package installations download prebuilt archives and never install dependencies; `node_modules` is not copied between machines
or architectures. CI explicitly checks Mac x64/arm64 and Windows x64/arm64,
including a process-interruption integration test. This is not a claim of
physical-device, power-loss, or all OS-version certification.

Linux and custom deployment layouts retain installation analysis and the source
upgrade prompt. Native updater scheduling assumes the user is logged in; after
a reboot, recovery resumes after login. Nothing can run while the machine is off.

## Enable once

Install a release containing this feature through the existing source workflow.
Its native `service install` records the launch specification and service-file
fingerprint outside the runtime. Retain your existing host, port, environment
file and proxy settings when installing that service.

From that same runtime:

```text
bun bin/stillon update setup
```

Setup requires a recorded native service with a fixed `127.0.0.1` listener.
It refuses an unknown launcher, a changed service definition, or a missing
installation record. It does not adopt a custom Task Scheduler task, launchd
label, terminal process, or third-party supervisor. Do not replace a working
custom launcher just to dismiss the setup message.

Setup builds a self-contained JavaScript controller outside the runtime and
rebuilds the current source once. It compares the generated files with the
deployed build before requesting native service adoption. Differences
require review; this prevents silently losing existing edits to `dist`.

The CLI then registers the independent worker and persists a setup request.
The worker owns the first service switch as well as subsequent updates. Closing
the initiating terminal after that handoff does not abandon a half-installed
service. An interrupted first switch restores the original service definition
on the next worker invocation. `update status` reports setup progress; use
`update recover` to request recovery or rerun `update setup` after a completed
restoration. Active agents and embedded terminals must finish before adoption.

On Windows, adoption checks the definition actually registered in Task Scheduler
as well as the saved XML file. It also stops the exact registered PowerShell
watchdog and its process tree: Task Scheduler's `/End` alone can leave children
running with the old log files open. Cleanup matches the full encoded launch
command and rechecks process creation time; it never kills every Bun process.

The native service then runs the stable application controller. A different
scheduled task / LaunchAgent owns the updater. Source upgrades never stop or
reinstall either of these supervisors.

## Upgrade

Settings → About checks releases and offers a short, copyable coding-agent
prompt when a newer stable release exists. The prompt asks the agent to preserve
customizations and data, stage and verify the update, and submit a deferred
request from an independent system task that survives StillOn and agent exit.
The native worker polls StillOn's authenticated idle check every five seconds for
up to twelve hours. Only after all active agent turns finish and embedded
terminals close does that worker request shutdown. If the old application is
still running after five seconds, the worker revalidates its managed instance
identity and force-terminates that process before backing up, upgrading and
restarting. An idle wait timeout leaves StillOn running and records the timeout
in the transaction. The initiating agent reports the task name, target version,
transaction ID and status file, then ends its turn instead of waiting in the
chat. The prompt also requests local/Connect verification and rollback on
failure through the native owner.
Copying the prompt does not schedule or run an update. The managed CLI remains
available for installations that use it.

Equivalent commands:

```text
bun bin/stillon update request v0.3.0 --prepare-only
bun bin/stillon update request v0.3.0 --wait-idle 12h
bun bin/stillon update request v0.3.0
bun bin/stillon update status
bun bin/stillon update recover
```

Replace the example tag with the desired stable source release. `--wait-idle`
accepts seconds or a duration such as `30m` or `12h`, bounded between five
seconds and twelve hours. It defers the switch until the native authenticated idle
check passes; the worker, not the caller, owns polling. A prepare-only request
cannot also wait for idle. Requests are explicit: the recovery task's periodic
timer does not choose or install new versions. Closing the browser, terminal or
initiating agent does not cancel an accepted request. A prepare-only result does
not switch the active application; a later upgrade request creates a new
transaction and rechecks current files.

## Transaction boundary

1. Save a binary-capable Git patch against the current release tag and additional
   source/configuration files. Clone into a new managed release directory.
2. Fetch the exact official release tag, apply customizations without forcing
   conflicting files, install native dependencies, and build both web clients.
3. Run the new application on an isolated port and disposable user home, with
   no real credentials/history. Verify version, instance identity, page bytes
   and referenced client assets. Existing application files remain untouched.
4. Check for active agent turns, draining work and embedded terminals. For a
   deferred request, journal `waiting-for-idle` and poll the authenticated native
   check every five seconds until idle or the bounded deadline. An immediate
   request refuses a busy switch. Journal the transition before asking the stable
   controller to pause the application.
5. Block new application work and shut down through an authenticated loopback
   control endpoint. Allow five seconds for process exit, then revalidate the old
   application’s persisted random identity and force-terminate a lingering process.
   Confirm exit before copying the StillOn data root.
6. Verify the stopped-server backup, journal that new code may access data, and
   select the exact new runtime. New user work remains blocked during checks.
7. Mark success after health/resource verification. If anything fails, pause,
   restore the backed-up data, select the old runtime and verify it before
   allowing user work again.

An updater lease is an authenticated loopback listener, not merely a PID.
During a switch, losing that lease causes the stable controller to pause the
application. A fresh updater treats an unfinished switch as rollback, not as
permission to retry new code against potentially migrated data.

The public health response identifies the managed instance but **does not
contain its shutdown credential**. A separate random secret is stored in
private controller state and passed only to that child. Recovery identifies
an orphaned child by its persisted random command-line identity; it does not
kill a process merely because it occupies the configured port.

## Customizations and data

Tracked CSS, components, icons, binary images and committed local changes are
captured relative to the current release tag. Additional source files and local
environment files are copied only when they do not conflict with a release
file. Relative source symlinks are preserved without copying their target contents when
the resolved target stays inside the source tree. Absolute, dangling, cyclic,
external, generated-file and user-data links require manual handling, as do
linked data/build trees, special files, runtime-local user data and conflicting
patches. Windows must support creating any links present in the source; inability
to create one stops preparation before the running application is changed.

Generated `dist` files have a verified checksum baseline. Direct changes stop
the upgrade until migrated into source. Dependency/editor caches are not
customization inputs. The updater does not add a new theme-loading contract;
the application's existing references to custom assets still need to work.

`~/.stillon` is backed up after the app stops. During rollback, data written by
the failed version is retained beside the original data root before restoring
the backup. Incomplete restore copies are preserved and retried; an invalid
backup leaves recovery pending. Project working trees and external agent data
are outside this backup and are not rolled back.

Managed infrastructure lives in:

- macOS: `~/Library/Application Support/StillOn/ManagedUpdates`
- Windows: `%LOCALAPPDATA%\StillOn\ManagedUpdates`

This is deliberately separate from the app's data root and source checkout.
Transaction journals, source patches, build/probe logs and data backups stay
local and may contain private material. No old runtime, quarantine or backup is
automatically deleted by this first implementation.

## Review / rollout limits

The updater is opt-in. Unknown service managers and unsupported platforms use
the existing prompt. Do not interpret a successful source build as a verified
native scheduler lifecycle: native setup/login/reboot checks must also be
performed on each deployment platform before broad rollout.

An explicit Windows native rehearsal is available:

```text
bun scripts/rehearse-managed-updates-windows.ts
```

It creates two uniquely named `StillOn.Rehearsal.<uuid>.*` tasks, isolated fixture
apps and a disposable user home. It terminates the worker during first adoption
and again during an app update, waits for the scheduler to recover automatically,
and checks the original data plus the quarantined failed-version data. The tasks
and owned processes are removed on completion; logs and a JSON report remain in
the printed temporary directory. Fixture releases bypass Git/build, which are
validated separately. This does not log out or reboot the machine.

Controllers are installed in immutable directories and stay pinned throughout
an application transaction. Replacing the updater/controller itself is a
separate maintenance operation; this first version does not overwrite its
own running helper. Future incompatible app/control protocols must fail
preflight rather than bypassing the controller.

Relevant platform references:
[Bun installation](https://bun.com/docs/installation),
[GitHub-hosted runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Desktop packages keep themes, skins and settings under the user data root, outside the immutable runtime. They are included in the same verified data backup and rollback as chat history. The planned theme/skin/UI-extension API is documented in desktop-distribution.md; arbitrary source edits still use the source channel.


## Moving from a source service to a package

Open the native app and confirm **Migrate to installer version**. A healthy recorded
managed source service migrates through a distinct persistent recovery task. Its
pinned controller and worker are handed over using journaled, immutable files;
service options, environment file and user data are retained. Source changes stay
in the previous runtime and are not applied to vendor package code. Unknown or
custom registrations remain unchanged. No local build occurs during migration.

The helper takes the same authenticated lease as normal updates, reserves the
request slot, stops the old update timer, stages/verifies the incoming package,
checks idle work and backs up stopped data. Only successful verification commits
desktop ownership. Failure or interruption restores the original deployment,
native service definitions, update timer, ownership metadata and matched data.
Closing the launcher does not cancel the native request. Recovery resumes when
the user is logged in; completed transactions never restore stale snapshots after
new user work has been allowed.

Normal beta releases now publish explicitly unsigned installers and runtime
archives. The app checks for the update manifest and an archive for its platform;
source-only or partially uploaded releases stay unavailable to package users.

### Diagnosing an application that cannot start

The managed controller writes each application instance's stderr to
`application-logs/<instance>.stderr.log` under the managed update root and records
its latest unexpected exit in `application-exit.json`. Each log retains at most
64 KiB of recent stderr. The eight newest logs and logs cited by the current
transaction's upgrade/recovery errors are retained. Log files use owner-only
permissions on Unix; logging failures do not block application startup.
These files stay local; they may contain private paths or application output and should be redacted
before sharing. Health-check timeouts identify known port/permission failures
and point to that instance log instead of copying raw stderr into update status.

If rollback also fails, `state.json` retains the original upgrade failure in
`error` and stores the rollback failure separately in `recoveryError`. A later
recovery worker preserves the original reason even if recovery fails again.
These controller diagnostics require a newly installed controller; updating only the app does not replace
an existing pinned controller.

## Verification contract

This contract applies to both the About copy prompt and the server-generated
source upgrade prompt. Read the **installed** runtime/controller documentation:
controllers are pinned outside application releases. A new checkout or app
upgrade does not add capabilities to an older controller.

### Use the existing transaction owner

For an enabled managed installation, use `bun bin/stillon update status`,
`bun bin/stillon update request <tag> --prepare-only`, then an explicit
`bun bin/stillon update request <tag> --wait-idle 12h` when ready,
`update recover` for recovery, and `update settings-snapshot` for preserved
settings evidence. These commands hand work to the registered **StillOn Updater**
Windows task or **com.bzbj.stillon.updater** macOS LaunchAgent. Do not register a
second transaction worker, import internal updater modules, replace verification
effects, or manually resume a verification gate to make a check pass.

`--wait-idle` is the supported deferred entry point. The request CLI wakes the
native worker immediately; the worker prepares the candidate, then polls the
authenticated idle check every five seconds until the application has no active
agent turns, running embedded terminals or pending mutations, or the bounded
deadline expires. While it waits, `update status` reports phase
`waiting-for-idle` with the transaction `id`, `idleWaitStartedAt` and
`idleDeadline`; a failed check is reported separately in `idleWaitError` and is
not treated as a settings mismatch. A timeout records phase `failed` and leaves
StillOn running; no backup, switch or data mutation occurred. The worker must
retain ownership of shutdown, identity checks, backup, switch and rollback. Do not
build a second poller, poll `/ws`, or invent unsupported flags; an OS-owned task
is needed only to delay the request and survive the initiating agent's exit.
Check the installed version's behavior because older pinned controllers do not
support `--wait-idle`. A prepare-only request cannot also wait for idle.
For custom/unmanaged services, preserve the launcher and follow the source
workflow; do not silently adopt them into managed updates. The unauthenticated
`/health?update-setup=1` readiness probe is for legacy setup, not a replacement for
the managed authenticated control check.

### Checks while paused

The new application starts with user work blocked until the transaction owner
finishes verification. Normal `/ws` access and mutations deliberately return 503.
A settings read command over `/ws` is therefore **unavailable**, not evidence
that settings changed. Keep that boundary intact during rollback verification too.

The native verifier checks `/health` (version, protocol and random instance
identity against the runner record), exact HTML and referenced asset bytes, and
startup stability. It does not establish authenticated Connect workspace access.

For managed installations with this CLI, capture read-only settings evidence:

```text
bun bin/stillon update settings-snapshot
```

It reads the recorded deployment's `dataRoot/data/settings.json` using the local
settings reader, without a running server, WebSocket, controller lease or gate
change. It reports `{ present, settings }`; missing settings are explicit, and
unreadable/invalid JSON is reported as `Settings snapshot unavailable` rather than
silently comparing fallback defaults. Save output privately before and after the
switch and compare the relevant preserved fields; new version defaults may add
fields. Snapshots can contain private configuration: do not paste them into
public logs, issues or PRs. A controller/verifier can run the command from the
runtime it is verifying; this read-only CLI does not replace the transaction owner.

On older versions or custom source installations, the existing read-only
`readAppSettingsSnapshot(settingsFile)` in `src/server/app-settings.ts` is usable
locally. Pass the actual settings file explicitly, record whether it exists and
reject warnings/defaults caused by invalid input. This is a local application
settings reader, not an internal updater orchestration interface. Do not read
settings by releasing the gate or adding a mutation exception.

### Connect evidence and redirects

Report these checks separately:

| Evidence | What it establishes |
| --- | --- |
| Local health, identity and asset checks | The selected local runtime is serving the expected build |
| Connect binding identity and transport online | The configured host is registered and its connector is online |
| Remote login gateway reachable | An unauthenticated request can reach the login flow |
| Authenticated workspace session | Login gateway, tunnel, adapter and application work together for that authorized session |

A normal unauthenticated request may redirect from the workspace to
`/_connect/login` and then to `/authorize` on the configured Connect origin,
where the authorization page returns 200. Inspect the redirect chain and require
HTTPS and the expected workspace/configured-origin hosts; do not require the
**final** URL to contain `/_connect/login`, and do not accept arbitrary off-origin
redirects. Bound requests and retries. HTTP 200 on an authorization page alone is
not authenticated workspace verification. If no authorized session is available,
report that level as unverified rather than claiming success or a proven runtime
failure. An explicitly required check that cannot be completed must remain
incomplete; do not silently weaken acceptance or bypass authentication.

### Status and failure causality

The managed `update status` output contains the transaction `id`, `targetTag`,
`phase`, `oldRuntime`, `newRuntime`, `backupReady`, original `error`, and separate
`recoveryError`. A deferred request also records `idleWaitSeconds`,
`idleWaitStartedAt` and `idleDeadline`; `waiting-for-idle` may include a separate
`idleWaitError` from the last authenticated check. The authoritative file is
`state.json` under ManagedUpdates; `transactions/<id>/journal.json` is written
before that state. After success the selected runtime is `newRuntime`; after
verified rollback it is `oldRuntime`. During recovery, confirm `control.json`,
`runner.json` and live health rather than inferring a completed selection from
the phase alone.

A scheduling adapter's status must identify the native transaction and these
paths. Preserve its original verifier failure alongside the final native
recovery outcome; never replace the cause with a generic recovery message or
present an adapter's exit code as the transaction result. Reuse the native owner
for recovery, and retain backups and quarantined data until recovery is verified.
