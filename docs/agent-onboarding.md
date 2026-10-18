# Set up one Agent

The Welcome checklist needs one signed-in provider. Choose Codex or Claude Code; StillOn checks only that CLI and does not send a model prompt. It reuses an existing installation and lets you choose an executable if automatic discovery fails. Those overrides are editable in `~/.stillon/data/provider-cli.json` and apply to checks and conversations.

For Codex, StillOn prefers a manually selected executable, then the CLI bundled with the ChatGPT/Codex desktop app, then a standalone CLI on PATH. macOS checks the user's and system Applications folders; Windows checks the current user's registered `OpenAI.Codex` package for its bundled CLI. The desktop app does not need to be running. If a bundled CLI is found, there is no separate CLI installation step. Recheck installation after installing or updating the app. Readiness checks, sign-in, conversations, model discovery and subscription usage all use the same selection. Claude Code continues to use its own CLI.

App discovery references (2026-10-18): [bundled Codex CLI on macOS](https://learn.chatgpt.com/docs/reference/troubleshooting#feature-is-working-in-the-codex-cli-but-not-in-the-chatgpt-desktop-app), [Windows package registration](https://learn.chatgpt.com/docs/enterprise/windows-deployment).

If the CLI is missing, Install opens a confirmation, then a visible terminal running the provider’s official standalone installer. It does not install the Codex/Claude desktop app. Already found CLIs cannot be automatically reinstalled by this action. After installation, recheck discovery before continuing.

Open terminal to sign in uses the resolved CLI and the same account-home/network environment. On macOS it opens Terminal; on Windows it opens a visible PowerShell window. Codex runs `codex login`; Claude Code runs `claude auth login`. Complete the official browser flow, return to StillOn and check sign-in. Closing or cancelling the terminal does not complete setup. Use the ready Agent to save it as the default for new conversations.

Install, sign-in and executable selection require the local StillOn page on the Agent computer. A remote browser can check readiness but cannot open a host terminal or change CLI paths.

Sources verified on 2026-10-17: [Codex CLI](https://developers.openai.com/codex/cli), [Codex authentication](https://developers.openai.com/codex/auth), [Claude setup](https://code.claude.com/docs/en/setup), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Installation and login are always explicitly initiated by the user; no real provider installation or account login is needed to test StillOn’s state/command flow.
