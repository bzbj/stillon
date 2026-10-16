import type { AgentProvider } from "./types"

export interface ProviderSetupStatus {
  provider: AgentProvider
  state: "missing" | "signed-out" | "ready" | "error"
  installed: boolean
  executable?: string
  version?: string
  message?: string
  platform: string
  canOpenTerminal: boolean
}

export const PROVIDER_SETUP_GUIDES = {
  codex: "https://developers.openai.com/codex/cli",
  claude: "https://code.claude.com/docs/en/setup",
} as const
