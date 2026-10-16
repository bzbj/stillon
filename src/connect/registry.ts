import type { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { CONNECT_LEASE_MS, CONNECT_OFFLINE_MS, type AccessLease, type ConnectHost, type DeviceProof } from "../shared/connect"
import { hashToken, pkceChallenge, publicKey, randomId, randomToken, verifyProof } from "../server/connect/crypto"
import { LoginGuard } from "./login-guard"
import { ConnectRegistryDatabase } from "./sqlite"

export class ConnectFault extends Error {
  constructor(public code: string, public status = 400, public retryAfterSeconds?: number) { super(code) }
}
export interface AccountIdentity { id: string; userId: string; email: string; expiresAt: number }
export interface HostRecord {
  id: string; ownerId: string; email: string; name: string; publicKey: string; epoch: number; keyVersion: number
  paused: number; revokedAt: number | null; lastSeen: number | null; createdAt: number
}
export interface EnrollmentRecord {
  id: string; publicKey: string; name: string; expiresAt: number; ownerId: string | null; email: string | null; hostId: string | null
}
export interface HostSessionRecord {
  id: string; tokenHash: string; hostId: string; parentId: string; ownerId: string; epoch: number; expiresAt: number; persistent: number
}
interface ConnectionRecord {
  hostId: string; instanceId: string; tokenHash: string; generation: number; expiresAt: number; runId: string | null; tunnelSeen: number
}
interface FlowRecord {
  id: string; hostId: string; challenge: string; state: string; returnPath: string; expiresAt: number
  codeHash: string | null; codeExpiresAt: number | null; parentId: string | null
}

export class ConnectRegistry {
  readonly db: Database
  readonly budgets: LoginGuard
  onInvalidate?: (scope: { hostId?: string; parentId?: string }) => void
  constructor(readonly dataDir: string, readonly origin: string, secret: string, readonly now = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const file = path.join(dataDir, "hosts.sqlite")
    this.db = new ConnectRegistryDatabase(file, { create: true, strict: true })
    chmodSync(file, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS enrollment (id TEXT PRIMARY KEY, publicKey TEXT NOT NULL, name TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, ownerId TEXT, email TEXT, hostId TEXT);
      CREATE TABLE IF NOT EXISTS host (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
        publicKey TEXT NOT NULL, epoch INTEGER NOT NULL, keyVersion INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        revokedAt INTEGER, lastSeen INTEGER, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS host_owner ON host(ownerId);
      CREATE TABLE IF NOT EXISTS device_challenge (hash TEXT PRIMARY KEY, subject TEXT NOT NULL, action TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection (hostId TEXT PRIMARY KEY REFERENCES host(id), instanceId TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, expiresAt INTEGER NOT NULL, runId TEXT, tunnelSeen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS revoked_session (id TEXT PRIMARY KEY, revokedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_preference (id TEXT PRIMARY KEY, persistent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_session (id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, hostId TEXT NOT NULL REFERENCES host(id),
        parentId TEXT NOT NULL, ownerId TEXT NOT NULL, epoch INTEGER NOT NULL, expiresAt INTEGER NOT NULL, persistent INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS host_session_parent ON host_session(parentId);
      CREATE TABLE IF NOT EXISTS auth_flow (id TEXT PRIMARY KEY, hostId TEXT NOT NULL REFERENCES host(id), challenge TEXT NOT NULL,
        state TEXT NOT NULL, returnPath TEXT NOT NULL, expiresAt INTEGER NOT NULL, codeHash TEXT, codeExpiresAt INTEGER, parentId TEXT);
    `)
    this.budgets = new LoginGuard(this.db, secret, now)
    // A process restart cannot preserve live transport ownership.
    this.db.query("UPDATE connection SET expiresAt=0, runId=NULL").run()
  }
  close() { this.db.close(true) }
  limited(key: string, max: number, seconds: number) {
    const retry = this.budgets.consume([{ key: this.budgets.digest("registry", key), max, windowSeconds: seconds }])
    if (retry) throw new ConnectFault("RATE_LIMITED", 429, retry)
  }
  hostOrigin(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ConnectFault("NOT_FOUND", 404)
    const url = new URL(this.origin)
    url.hostname = `h-${id}.${url.hostname}`
    return url.origin
  }
  hostIdForAuthority(authority: string) {
    const url = new URL(this.origin)
    const suffix = `.${url.host}`
    if (!authority.endsWith(suffix)) return null
    const match = /^h-([a-f0-9]{32})$/.exec(authority.slice(0, -suffix.length))
    return match?.[1] ?? null
  }
  host(id: string) { return this.db.query<HostRecord, [string]>("SELECT * FROM host WHERE id=?").get(id) }
  requireHost(id: string, owner?: string) {
    const host = this.host(id)
    if (!host || host.revokedAt !== null || (owner && host.ownerId !== owner)) throw new ConnectFault("NOT_FOUND", 404)
    return host
  }
  publicHost(host: HostRecord): ConnectHost {
    const connection = this.connection(host.id)
    return { id: host.id, name: host.name, paused: Boolean(host.paused),
      online: !host.paused && host.revokedAt === null && Boolean(connection?.runId && connection.expiresAt > this.now() && this.now() - connection.tunnelSeen < CONNECT_OFFLINE_MS && host.lastSeen !== null && this.now() - host.lastSeen < CONNECT_OFFLINE_MS),
      lastSeen: host.lastSeen, url: this.hostOrigin(host.id) }
  }
  hosts(ownerId: string) {
    return this.db.query<HostRecord, [string]>("SELECT * FROM host WHERE ownerId=? AND revokedAt IS NULL ORDER BY createdAt,id").all(ownerId).map(h => this.publicHost(h))
  }
  enrollment(id: string) { return this.db.query<EnrollmentRecord, [string]>("SELECT * FROM enrollment WHERE id=?").get(id) }
  pendingEnrollment(id: string) {
    const row = this.enrollment(id)
    if (!row || row.expiresAt <= this.now() || row.hostId) throw new ConnectFault("BINDING_EXPIRED", 410)
    return row
  }
  createEnrollment(key: string, name: string) {
    publicKey(key)
    this.db.query("DELETE FROM enrollment WHERE expiresAt<=? AND hostId IS NULL").run(this.now())
    const existing = this.db.query<EnrollmentRecord, [string, number]>("SELECT * FROM enrollment WHERE publicKey=? AND expiresAt>? AND hostId IS NULL").get(key, this.now())
    if (existing) return existing
    const id = randomId(), expiresAt = this.now() + 10 * 60_000
    this.db.query("INSERT INTO enrollment(id,publicKey,name,expiresAt) VALUES (?,?,?,?)").run(id, key, name, expiresAt)
    return this.enrollment(id)!
  }
  approveEnrollment(id: string, identity: AccountIdentity) {
    this.db.transaction(() => {
      const row = this.pendingEnrollment(id)
      if (row.ownerId && row.ownerId !== identity.userId) throw new ConnectFault("BINDING_EXPIRED", 410)
      this.db.query("UPDATE enrollment SET ownerId=?, email=? WHERE id=?").run(identity.userId, identity.email, id)
    }).immediate()
  }
  claimEnrollment(id: string, key: string) {
    return this.db.transaction(() => {
      const row = this.enrollment(id)
      if (!row || row.publicKey !== key) throw new ConnectFault("NOT_FOUND", 404)
      if (row.hostId) return this.requireHost(row.hostId)
      if (row.expiresAt <= this.now()) throw new ConnectFault("BINDING_EXPIRED", 410)
      if (!row.ownerId || !row.email) return null
      const hostId = randomId()
      this.db.query("INSERT INTO host(id,ownerId,email,name,publicKey,epoch,keyVersion,createdAt) VALUES (?,?,?,?,?,1,1,?)")
        .run(hostId, row.ownerId, row.email, row.name, row.publicKey, this.now())
      this.db.query("UPDATE enrollment SET hostId=? WHERE id=?").run(hostId, id)
      return this.requireHost(hostId)
    }).immediate()
  }
  cancelEnrollment(id: string, key: string) {
    this.db.transaction(() => {
      const row = this.enrollment(id)
      if (!row || row.publicKey !== key) throw new ConnectFault("NOT_FOUND", 404)
      // A lost claim response may already have created a host. Retire that
      // exact identity, but never allow an old enrollment key after rotation.
      if (row.hostId) {
        const host = this.host(row.hostId)
        if (host && host.revokedAt === null) {
          if (host.publicKey !== key) throw new ConnectFault("NOT_FOUND", 404)
          this.revokeHost(host.id)
        }
      }
      this.db.query("UPDATE enrollment SET expiresAt=0, ownerId=NULL, email=NULL WHERE id=?").run(id)
    }).immediate()
  }
  createChallenge(subject: string, action: string) {
    this.db.query("DELETE FROM device_challenge WHERE expiresAt<=?").run(this.now())
    const challenge = randomToken()
    this.db.query("INSERT INTO device_challenge VALUES (?,?,?,?)").run(hashToken(challenge), subject, action, this.now() + 60_000)
    return challenge
  }
  consumeProof(proof: DeviceProof) {
    return this.db.transaction(() => {
      const row = this.db.query<{ subject: string; action: string; expiresAt: number }, [string]>("SELECT * FROM device_challenge WHERE hash=?").get(hashToken(proof.challenge))
      if (!row || row.expiresAt <= this.now() || row.subject !== proof.subject || row.action !== proof.action) throw new ConnectFault("INVALID_PROOF", 403)
      let key: string
      if (proof.subject.startsWith("key:")) key = proof.subject.slice(4)
      else key = this.requireHost(proof.subject).publicKey
      if (!verifyProof(proof, key)) throw new ConnectFault("INVALID_PROOF", 403)
      this.db.query("DELETE FROM device_challenge WHERE hash=?").run(hashToken(proof.challenge))
      return key
    }).immediate()
  }
  connection(hostId: string) { return this.db.query<ConnectionRecord, [string]>("SELECT * FROM connection WHERE hostId=?").get(hostId) }
  openConnection(hostId: string, instanceId: string) {
    return this.db.transaction(() => {
      const host = this.requireHost(hostId)
      if (host.paused) throw new ConnectFault("ACCESS_PAUSED", 403)
      const old = this.connection(hostId)
      if (old && old.expiresAt > this.now() && old.instanceId !== instanceId) throw new ConnectFault("DEVICE_ALREADY_CONNECTED", 409, 45)
      const token = randomToken(), generation = (old?.generation ?? 0) + 1
      this.db.query("INSERT INTO connection(hostId,instanceId,tokenHash,generation,expiresAt,runId) VALUES (?,?,?,?,?,NULL) ON CONFLICT(hostId) DO UPDATE SET instanceId=excluded.instanceId,tokenHash=excluded.tokenHash,generation=excluded.generation,expiresAt=excluded.expiresAt,runId=NULL,tunnelSeen=0")
        .run(hostId, instanceId, hashToken(token), generation, this.now() + CONNECT_OFFLINE_MS)
      this.db.query("UPDATE host SET lastSeen=? WHERE id=?").run(this.now(), hostId)
      return { token, generation }
    }).immediate()
  }
  heartbeat(hostId: string, instanceId: string, generation: number) {
    const host = this.requireHost(hostId), connection = this.connection(hostId)
    if (host.paused) throw new ConnectFault("ACCESS_PAUSED", 403)
    if (!connection || connection.expiresAt <= this.now() || connection.instanceId !== instanceId || connection.generation !== generation) throw new ConnectFault("CONNECTION_EXPIRED", 409)
    this.db.query("UPDATE connection SET expiresAt=? WHERE hostId=?").run(this.now() + CONNECT_OFFLINE_MS, hostId)
    this.db.query("UPDATE host SET lastSeen=? WHERE id=?").run(this.now(), hostId)
  }
  frpCredential(hostId: string, token: string, runId: string, operation: string) {
    const host = this.host(hostId), connection = this.connection(hostId)
    if (!host || host.revokedAt !== null || host.paused || !connection || connection.expiresAt <= this.now() || connection.tokenHash !== hashToken(token)) return false
    if (connection.runId && connection.runId !== runId) return false
    if (operation === "NewProxy" && !connection.runId) {
      if (!runId) return false
      this.db.query("UPDATE connection SET runId=? WHERE hostId=? AND runId IS NULL").run(runId, hostId)
    }
    if (["NewProxy", "Ping"].includes(operation)) this.db.query("UPDATE connection SET tunnelSeen=? WHERE hostId=?").run(this.now(), hostId)
    return true
  }
  setPaused(id: string, paused: boolean) {
    this.requireHost(id)
    this.db.query("UPDATE host SET paused=? WHERE id=?").run(paused ? 1 : 0, id)
    if (paused) { this.db.query("UPDATE connection SET expiresAt=0 WHERE hostId=?").run(id); this.onInvalidate?.({ hostId: id }) }
  }
  rename(id: string, owner: string, name: string) { this.requireHost(id, owner); this.db.query("UPDATE host SET name=? WHERE id=?").run(name, id) }
  rotateKey(id: string, key: string) {
    publicKey(key); this.requireHost(id)
    this.db.transaction(() => {
      this.db.query("UPDATE host SET publicKey=?,keyVersion=keyVersion+1,epoch=epoch+1 WHERE id=?").run(key, id)
      this.db.query("DELETE FROM host_session WHERE hostId=?").run(id)
      this.db.query("UPDATE connection SET expiresAt=0 WHERE hostId=?").run(id)
    }).immediate()
    this.onInvalidate?.({ hostId: id })
  }
  revokeHost(id: string, owner?: string) {
    this.requireHost(id, owner)
    this.db.transaction(() => {
      this.db.query("UPDATE host SET revokedAt=?,epoch=epoch+1 WHERE id=?").run(this.now(), id)
      this.db.query("DELETE FROM host_session WHERE hostId=?").run(id)
      this.db.query("UPDATE connection SET expiresAt=0 WHERE hostId=?").run(id)
      this.db.query("DELETE FROM auth_flow WHERE hostId=?").run(id)
    }).immediate()
    this.onInvalidate?.({ hostId: id })
  }
  isRevoked(id: string) { return Boolean(this.db.query("SELECT id FROM revoked_session WHERE id=?").get(id)) }
  remember(id: string, persistent: boolean) { this.db.query("INSERT OR REPLACE INTO session_preference VALUES (?,?)").run(id, persistent ? 1 : 0) }
  revokeParent(id: string) {
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO revoked_session VALUES (?,?)").run(id, this.now())
      this.db.query("DELETE FROM host_session WHERE parentId=?").run(id)
      this.db.query("DELETE FROM auth_flow WHERE parentId=?").run(id)
    }).immediate()
    this.onInvalidate?.({ parentId: id })
  }
  newFlow(hostId: string, returnPath: string) {
    this.requireHost(hostId)
    this.db.query("DELETE FROM auth_flow WHERE expiresAt<=?").run(this.now())
    const id = randomId(), verifier = randomToken(), state = randomToken()
    this.db.query("INSERT INTO auth_flow(id,hostId,challenge,state,returnPath,expiresAt) VALUES (?,?,?,?,?,?)")
      .run(id, hostId, pkceChallenge(verifier), state, returnPath, this.now() + 10 * 60_000)
    return { id, verifier, state }
  }
  flow(id: string) {
    const flow = this.db.query<FlowRecord, [string]>("SELECT * FROM auth_flow WHERE id=?").get(id)
    if (!flow || flow.expiresAt <= this.now()) throw new ConnectFault("LOGIN_EXPIRED", 410)
    return flow
  }
  authorizeFlow(id: string, identity: AccountIdentity) {
    return this.db.transaction(() => {
      const flow = this.flow(id)
      this.requireHost(flow.hostId, identity.userId)
      if (this.isRevoked(identity.id) || identity.expiresAt <= this.now()) throw new ConnectFault("AUTH_REQUIRED", 401)
      if (flow.codeHash) throw new ConnectFault("LOGIN_EXPIRED", 410)
      const code = randomToken()
      this.db.query("UPDATE auth_flow SET codeHash=?,codeExpiresAt=?,parentId=? WHERE id=?").run(hashToken(code), this.now() + 30_000, identity.id, id)
      return `${this.hostOrigin(flow.hostId)}/_connect/callback?flow=${id}&code=${code}&state=${flow.state}`
    }).immediate()
  }
  exchangeFlow(id: string, hostId: string, verifier: string, code: string, state: string, readIdentity: (id: string) => AccountIdentity | null) {
    return this.db.transaction(() => {
      const flow = this.flow(id)
      if (flow.hostId !== hostId || !flow.parentId || flow.challenge !== pkceChallenge(verifier) || flow.codeHash !== hashToken(code)
        || flow.state !== state || !flow.codeExpiresAt || flow.codeExpiresAt <= this.now()) throw new ConnectFault("LOGIN_EXPIRED", 410)
      const identity = readIdentity(flow.parentId)
      if (!identity || this.isRevoked(identity.id) || identity.expiresAt <= this.now()) throw new ConnectFault("AUTH_REQUIRED", 401)
      const host = this.requireHost(hostId, identity.userId)
      const sessionId = randomId(), token = randomToken()
      const persistent = this.db.query<{ persistent: number }, [string]>("SELECT persistent FROM session_preference WHERE id=?").get(identity.id)?.persistent ?? 0
      this.db.query("INSERT INTO host_session VALUES (?,?,?,?,?,?,?,?)").run(sessionId, hashToken(token), hostId, identity.id, identity.userId, host.epoch, identity.expiresAt, persistent)
      this.db.query("DELETE FROM auth_flow WHERE id=?").run(id)
      return { token, returnPath: flow.returnPath, expiresAt: identity.expiresAt, persistent: Boolean(persistent) }
    }).immediate()
  }
  sessionForToken(hostId: string, token: string, readIdentity: (id: string) => AccountIdentity | null) {
    const session = this.db.query<HostSessionRecord, [string, string]>("SELECT * FROM host_session WHERE tokenHash=? AND hostId=?").get(hashToken(token), hostId)
    return session && this.validSession(session, readIdentity) ? session : null
  }
  validSession(session: HostSessionRecord, readIdentity: (id: string) => AccountIdentity | null) {
    const identity = readIdentity(session.parentId), host = this.host(session.hostId)
    return Boolean(identity && identity.expiresAt > this.now() && identity.userId === session.ownerId
      && !this.isRevoked(identity.id) && session.expiresAt > this.now() && host && host.revokedAt === null
      && host.ownerId === session.ownerId && host.epoch === session.epoch)
  }
  makeLease(session: HostSessionRecord, method: string, requestPath: string): AccessLease {
    const host = this.requireHost(session.hostId), connection = this.connection(host.id)
    if (!this.publicHost(host).online || !connection) throw new ConnectFault("HOST_OFFLINE", 503, 5)
    const now = this.now()
    return { v: 1, id: randomId(), hostId: host.id, sessionId: session.id, parentId: session.parentId,
      ownerId: session.ownerId, epoch: host.epoch, generation: connection.generation,
      method, path: requestPath, issuedAt: now, expiresAt: Math.min(now + CONNECT_LEASE_MS, session.expiresAt) }
  }
  renewLease(lease: AccessLease, readIdentity: (id: string) => AccountIdentity | null) {
    const session = this.db.query<HostSessionRecord, [string]>("SELECT * FROM host_session WHERE id=?").get(lease.sessionId)
    if (!session || !this.validSession(session, readIdentity) || session.hostId !== lease.hostId || session.parentId !== lease.parentId
      || session.ownerId !== lease.ownerId || session.epoch !== lease.epoch) return null
    const renewed = this.makeLease(session, lease.method, lease.path)
    if (renewed.generation !== lease.generation) return null
    return { ...renewed, id: lease.id }
  }
}
