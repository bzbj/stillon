import { isIP } from "node:net"

/** Public, checksum-sealed package configuration. Never contains credentials. */
export interface ConnectRuntimeConfig {
  origin: string
  migrateFromOrigins?: string[]
}

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Connect origin must be an HTTPS origin")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("Connect origin must be an HTTPS origin")
  return url.origin
}

export function parseConnectRuntimeConfig(input: unknown): ConnectRuntimeConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Connect runtime configuration")
  const value = input as Record<string, unknown>
  const origin = httpsOrigin(value.origin)
  const migration = value.migrateFromOrigins === undefined ? [] : value.migrateFromOrigins
  if (!Array.isArray(migration) || migration.length > 16) throw new Error("Invalid Connect migration origins")
  const migrateFromOrigins = [...new Set(migration.map(httpsOrigin))]
  if (migrateFromOrigins.includes(origin)) throw new Error("Connect migration must use a different old origin")
  return { origin, ...(migrateFromOrigins.length ? { migrateFromOrigins } : {}) }
}

export function desktopConnectConfig(environment: Record<string, string | undefined>): ConnectRuntimeConfig | null {
  const required = environment.STILLON_REQUIRE_CONNECT === "1"
  const origin = environment.STILLON_CONNECT_ORIGIN
  if (required && !origin) throw new Error("Managed builds require STILLON_CONNECT_ORIGIN")
  const migration = JSON.parse(environment.STILLON_CONNECT_MIGRATE_FROM_ORIGINS || "[]") as unknown
  if (!origin && !required && Array.isArray(migration) && migration.length === 0) return null
  const config = parseConnectRuntimeConfig({ origin, migrateFromOrigins: migration })
  const hostname = new URL(config.origin).hostname.replace(/\.$/, "")
  if (required && (isIP(hostname.replace(/^\[|\]$/g, "")) || !hostname.includes(".")
    || /(?:^|\.)(?:example|invalid|test|localhost|local)$/.test(hostname)
    || /(?:^|\.)example\.(?:com|net|org)$/.test(hostname))) throw new Error("Managed packages require a public deployment origin, not an example or local address")
  return config
}

interface StoredOrigins {
  origin: string
  enrollment?: { verificationUrl: string }
  binding?: { hostId: string; url: string }
}

function moveUrl(value: string, from: string, to: string, hostId?: string) {
  try {
    const url = new URL(value), old = new URL(from), target = new URL(to)
    if (hostId) { old.hostname = `h-${hostId}.${old.hostname}`; target.hostname = `h-${hostId}.${target.hostname}` }
    if (url.origin !== old.origin || url.username || url.password) return value
    return `${target.origin}${url.pathname}${url.search}${url.hash}`
  } catch { return value }
}

/** Move only the approved authority/URLs; preserve identity and pending actions. */
export function migrateConnectState<T extends StoredOrigins>(state: T, origin: string): T {
  return { ...state, origin,
    ...(state.enrollment ? { enrollment: { ...state.enrollment, verificationUrl: moveUrl(state.enrollment.verificationUrl, state.origin, origin) } } : {}),
    ...(state.binding ? { binding: { ...state.binding, url: moveUrl(state.binding.url, state.origin, origin, state.binding.hostId) } } : {}),
  }
}
