# Session statistics design preview

Open [session-statistics.html](session-statistics.html) directly in a browser. It is a self-contained interactive design with embedded StillOn fonts and synthetic data.

The preview follows the existing workspace and Settings layouts. In **Settings → Usage**, **Show session statistics** starts off and saves its preview preference locally. Turn it on, then select **会话页** in the preview toolbar to see two quiet controls above the composer: output speed and cumulative session tokens. Each opens its corresponding timing or token details.

The preview toolbar also switches between desktop/mobile sizing and light/dark themes. Select Codex, Claude Code or DeepSeek Harness in the composer to inspect the shared presentation. These controls operate only on the prototype. It makes no network or model requests and does not change application settings.

For a fresh disabled state, open `session-statistics.html?enabled=0`. Other review parameters are `view=chat`, `theme=dark`, `device=mobile`, and, when enabled, `panel=timing` or `panel=tokens`.

This is a design proposal. Runtime statistics collection and the production Settings integration are separate implementation work.
