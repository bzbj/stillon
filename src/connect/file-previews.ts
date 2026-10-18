import { randomBytes } from "node:crypto"
import type { HostSessionRecord } from "./registry"

/** Ephemeral, parent-session-bound file origins. The durable target ID is never a credential. */
export class ConnectFilePreviews {
  private readonly grants = new Map<string, { session: HostSessionRecord; targetId: string; scopeKey: string; expires: number }>()
  constructor(private readonly accountOrigin: string, private readonly valid: (session: HostSessionRecord) => boolean) {}
  target(authority: string) {
    const suffix = "." + new URL(this.accountOrigin).host
    if (!authority.endsWith(suffix)) return null
    const match = /^f-([a-f0-9]{32})-([a-f0-9]{24})$/u.exec(authority.slice(0, -suffix.length))
    return match ? { hostId: match[1]!, token: match[2]! } : null
  }
  start(session: HostSessionRecord, targetId: string, path: string, scopeKey: string) {
    if (!this.valid(session)) throw new Error("File preview session expired.")
    for (const [token, grant] of this.grants) if (grant.expires <= Date.now() || !this.valid(grant.session)) this.grants.delete(token)
    let token = [...this.grants].find(([, g]) => g.session.id === session.id && g.scopeKey === scopeKey)?.[0]
    if (!token) {
      if (this.grants.size >= 1024) throw new Error("File preview limit reached.")
      token = randomBytes(12).toString("hex")
      this.grants.set(token, { session, targetId, scopeKey, expires: Date.now() + 60 * 60_000 })
    }
    // Reauthorize the same directory through the current live document without
    // changing its origin for query/fragment navigation or another document.
    this.grants.get(token)!.targetId = targetId
    const url = new URL(this.accountOrigin)
    url.hostname = `f-${session.hostId}-${token}.${url.hostname}`
    return url.origin + path
  }
  resolve(authority: string) {
    const target = this.target(authority), grant = target ? this.grants.get(target.token) : undefined
    return target && grant && grant.session.hostId === target.hostId && grant.expires > Date.now() && this.valid(grant.session) ? grant : null
  }
  clear() { this.grants.clear() }
}
