# Managed source updates (opt-in)

Managed updates replace the normal two-agent upgrade workflow with a persistent,
independent updater. The first implementation builds source releases locally;
it does not download unsigned third-party executables or require Python.

## Platforms

| Installation | Bun architecture | Updater owner |
| --- | --- | --- |
| Intel Mac | x64 | Separate user LaunchAgent |
| Apple Silicon Mac | arm64 | Separate user LaunchAgent |
| Windows PC / Intel Surface | x64 | Separate user scheduled task |
| Windows on Arm / Arm Surface | arm64 | Separate user scheduled task |

The service's **Bun executable architecture** determines native dependencies.
An x64 Bun running under emulation keeps x64 dependencies; it is never silently
switched to arm64 based on a device name. Each prepared release gets a fresh
`bun install --frozen-lockfile`; `node_modules` is not copied between machines
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

Settings → Changelog shows **Prepare only** and **Upgrade to …** when the running
instance belongs to a managed deployment. The original installation-analysis
entry remains available for unsupported layouts and customization conflicts.

Equivalent commands:

```text
bun bin/stillon update request v0.3.0 --prepare-only
bun bin/stillon update request v0.3.0
bun bin/stillon update status
bun bin/stillon update recover
```

Replace the example tag with the desired stable source release. Requests are
explicit: the recovery task's periodic timer does not choose or install new
versions. Closing the browser, terminal or initiating agent does not cancel an
accepted request. A prepare-only result does not switch the active application;
a later upgrade request creates a new transaction and rechecks current files.

## Transaction boundary

1. Save a binary-capable Git patch against the current release tag and additional
   source/configuration files. Clone into a new managed release directory.
2. Fetch the exact official release tag, apply customizations without forcing
   conflicting files, install native dependencies, and build both web clients.
3. Run the new application on an isolated port and disposable user home, with
   no real credentials/history. Verify version, instance identity, page bytes
   and referenced client assets. Existing application files remain untouched.
4. Check for active agent turns, draining work and embedded terminals. Refuse
   a busy switch. Journal the transition before asking the stable controller
   to pause the application.
5. Block new application work and shut down through an authenticated loopback
   control endpoint. Wait for process exit before copying the StillOn data root.
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
file. Symlinks/junctions, special files, runtime-local user data and conflicting
patches require manual handling.

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
