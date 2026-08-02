# Windows background service

StillOn can run in the foreground without installing a service. Use that mode
first to build the selected revision, verify `http://127.0.0.1:3210/health`,
open the app, and complete provider first use.

After those checks succeed, the optional per-user background service is the
recommended persistent startup method on Windows. It keeps the runtime
headless and supervised without requiring every operator or installation
agent to create a custom Scheduled Task or PowerShell watchdog.

## Install from a pinned runtime

Keep the runtime separate from a development checkout and invoke the
entrypoint inside that runtime. A global `stillon` installation is not
required:

```powershell
$RuntimeRoot = "C:\path\to\stillon-runtime"
bun "$RuntimeRoot\bin\stillon" service install --port 3210
bun "$RuntimeRoot\bin\stillon" service status
Invoke-RestMethod http://127.0.0.1:3210/health
```

If the agent processes need an already-running local proxy, pass a dedicated
environment file with `--env-file <absolute-path>`. Keep inbound access,
firewall rules, tunnels, VPN management, and proxy lifecycle out of this
command.

Installation creates the current-user Task Scheduler task `\StillOn`. It is a
follow-up operational choice, not an installation prerequisite.

## Headless startup

The task starts this process chain when the selected user signs in:

```text
Task Scheduler
  -> conhost.exe --headless
  -> non-interactive Windows PowerShell supervisor
  -> Bun
  -> StillOn
```

`conhost.exe --headless` hosts the console process without creating a visible
console window. PowerShell also receives `-WindowStyle Hidden` as a secondary
guard. The task uses an interactive user token, so it starts after sign-in; it
is not a machine service that starts before login.

The task also uses `StartWhenAvailable`, ignores duplicate starts, has no
execution time limit, and runs at least privilege. A named per-session mutex
adds a second duplicate-supervisor guard.

## Indefinite supervision

The PowerShell supervisor owns the normal StillOn restart policy. Whenever
Bun exits, it waits according to this sequence:

```text
5 seconds -> 10 seconds -> 20 seconds -> 40 seconds -> 60 seconds
                                                -> 60 seconds indefinitely
```

A Bun run lasting at least five minutes resets the next delay to five seconds.
Every exit and selected restart delay is appended to the service error log.

Task Scheduler retains a separate fallback of five retries at one-minute
intervals when the task action itself is reported failed. That bounded policy
does not govern Bun exits and therefore does not bound Bun restarts, which
continue indefinitely while the supervisor is running.

## Operate and inspect

Run lifecycle commands through the same pinned runtime that installed the
task:

```powershell
$RuntimeRoot = "C:\path\to\stillon-runtime"
bun "$RuntimeRoot\bin\stillon" service status
bun "$RuntimeRoot\bin\stillon" service logs
bun "$RuntimeRoot\bin\stillon" service uninstall
```

Logs live under `%LOCALAPPDATA%\StillOn\`:

- `service.out.log`
- `service.err.log`
- `service-task.xml`

`service uninstall` removes the Scheduled Task and generated task XML. It does
not remove projects, settings, or conversation data under `~/.stillon/`.

## Update and roll back

Build and validate a new release directory on an unused port before replacing
the task. Then run `service install` from the new runtime. The command replaces
the existing `\StillOn` task and records the new runtime as its working
directory.

To roll back, run the same `service install` command from a known-good runtime.
Do not point the task at a mutable development checkout, and do not create a
second custom task alongside `\StillOn`; duplicate supervisors will compete
for the strict service port.
