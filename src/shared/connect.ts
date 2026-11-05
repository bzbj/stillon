/** Wire contracts shared by the browser, device connector and account service. */
export const CONNECT_PROTOCOL = 1
export const CONNECT_HEARTBEAT_MS = 15_000
export const CONNECT_OFFLINE_MS = 45_000
export const CONNECT_LEASE_MS = 45_000
export const CONNECT_MAX_HTTP_BYTES = 110 * 1024 * 1024
export const CONNECT_MAX_WS_BYTES = 5 * 1024 * 1024
export const CONNECT_MAX_STREAMS = 32

export type ConnectIntent = { purpose: "enroll"; id: string } | { purpose: "revoke-host"; id: string }
export interface ConnectHost {
  id: string
  name: string
  online: boolean
  paused: boolean
  lastSeen: number | null
  url: string
}
/** One account login, including its tabs and computer sessions. Never a bearer token. */
export interface ConnectBrowserSession {
  id: string
  browser: string
  platform: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  current: boolean
}
export interface ConnectBrowserSessions {
  sessions: ConnectBrowserSession[]
  /** Server time keeps expiry labels independent of the browser clock. */
  now: number
}
export interface ConnectLocalStatus {
  configured: boolean
  origin: string | null
  state: "unbound" | "pending" | "connecting" | "online" | "offline" | "paused" | "revoked" | "revocation-pending"
  name: string
  email?: string
  hostId?: string
  url?: string
  enrollment?: { id: string; verificationUrl: string; expiresAt: number }
  error?: string
  transport?: { state: "ready" | "missing" | "preparing" | "error"; version: string; error?: string }
}
export interface ConnectRemoteStatus {
  mode: "connect"
  enabled: true
  authenticated: boolean
  cacheScope: null
  loginUrl: string
  portalUrl: string
  email?: string
  sharedWorkspace?: { id: string; name: string }
  host?: ConnectHost
}
export interface DeviceProof {
  subject: string
  challenge: string
  action: string
  payload: Record<string, unknown>
  signature: string
}
export interface AccessLease {
  v: 1
  id: string
  hostId: string
  sessionId: string
  parentId: string
  ownerId: string
  actorId?: string
  workspaceId?: string
  epoch: number
  generation: number
  method: string
  path: string
  issuedAt: number
  expiresAt: number
}

export interface WorkspaceSharingSnapshot {
  workspaces: { workspaceId: string; title: string; members: { id: string; email: string; status: "pending" | "joined"; invitationUrl: string }[] }[]
}
export interface SharedWorkspaceEntry {
  id: string; hostId: string; machineName: string; workspaceId: string; workspaceName: string; name: string;
  online: boolean; accepted: boolean; url: string; invitationUrl: string
}
