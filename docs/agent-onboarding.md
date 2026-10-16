# Set up one Agent

The Welcome checklist needs one signed-in provider. Choose Codex or Claude Code; StillOn checks only that CLI and does not send a model prompt. It reuses an existing installation and lets you choose an executable if automatic discovery fails. Those overrides are editable in `~/.stillon/data/provider-cli.json` and apply to checks and conversations.

If the CLI is missing, Install opens a confirmation, then a visible terminal running the provider’s official standalone installer. It does not install the Codex/Claude desktop app. Already found CLIs cannot be automatically reinstalled by this action. After installation, recheck discovery before continuing.

Open terminal to sign in uses the resolved CLI and the same account-home/network environment. On macOS it opens Terminal; on Windows it opens a visible PowerShell window. Codex runs `codex login`; Claude Code runs `claude auth login`. Complete the official browser flow, return to StillOn and check sign-in. Closing or cancelling the terminal does not complete setup. Use the ready Agent to save it as the default for new conversations.

Install, sign-in and executable selection require the local StillOn page on the Agent computer. A remote browser can check readiness but cannot open a host terminal or change CLI paths.

Sources verified on 2026-10-17: [Codex CLI](https://developers.openai.com/codex/cli), [Codex authentication](https://developers.openai.com/codex/auth), [Claude setup](https://code.claude.com/docs/en/setup), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installation and login are always explicitly initiated by the user; no real provider installation or account login is needed to test StillOn’s state/command flow.
