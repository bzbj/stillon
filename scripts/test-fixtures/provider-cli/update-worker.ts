import { ProviderCliUpdates } from "../../../src/server/provider-cli-updates"

const manager = new ProviderCliUpdates({
  journalDirectory: process.argv[2],
  getEnvironment: async () => process.env,
  reserve: async () => () => {},
  release: async () => ({ version: "1.2.4", publishedAt: "2026-01-01T00:00:00.000Z", url: "https://github.com/openai/codex/releases/tag/rust-v1.2.4" }),
})
await manager.start("codex", (await manager.status("codex")).updateToken!)
await manager.close()
