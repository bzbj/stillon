# Provider CLI environment

StillOn uses the current host user’s command-line Agent. It searches the effective user PATH before adding fallback CLI locations. Windows discovery accepts native `.exe` installations and npm `.cmd` shims, preserving directory order. macOS refreshes the login-shell PATH, including Homebrew and shell-managed Node installations.

Provider checks refresh that environment without restarting active conversations or installing another CLI. New child processes use the refreshed environment. Native service and updater definitions read the current user/system environment rather than forcing the installation-time PATH snapshot; the recorded PATH remains a fallback.

For an explicit override in the service environment file, set `CODEX_EXECUTABLE` or `CLAUDE_EXECUTABLE` to the desired CLI path. `STILLON_AGENT_PATH` can put an explicit search path first. Account-home and network variables remain inherited. Keep each provider’s detection, official login, metadata checks and conversations on the same CLI and account directory.

If detection fails, recheck after fixing the user PATH or choose the existing executable. A missing command does not by itself establish that a new installation is needed.
