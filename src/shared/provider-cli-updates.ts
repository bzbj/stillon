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
  startedAt?: string
  attempts?: number
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
  /** Consent to repair the same recorded installation at this exact version. */
  repairToken?: string
  repairVersion?: string
  reason?: string
  releaseError?: string
  operation?: CliUpdateOperation
}
