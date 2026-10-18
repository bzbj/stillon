import type { AgentProvider } from "./types"

export interface CliRelease {
  version: string
  publishedAt: string
  url: string
}

export interface CliUpdateOperation {
  id: string
  targetVersion: string
  state: "updating" | "succeeded" | "failed"
  message: string
}

export interface ProviderCliUpdateStatus {
  provider: AgentProvider
  executable?: string
  currentVersion?: string
  installation: string
  automaticUpdates: string
  latest?: CliRelease
  updateAvailable: boolean
  /** Opaque, short-lived consent for this exact installation and release. */
  updateToken?: string
  reason?: string
  releaseError?: string
  operation?: CliUpdateOperation
}
