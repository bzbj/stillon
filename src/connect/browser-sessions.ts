import type { Database } from "bun:sqlite"
import type { ConnectBrowserSessions } from "../shared/connect"

export function browserDescription(value: string | null) {
  const agent = (value ?? "").slice(0, 1_024)
  const browser = /Edg(?:A|iOS)?\//.test(agent) ? "Edge" : /(?:OPR|Opera)\//.test(agent) ? "Opera"
    : /(?:Firefox|FxiOS)\//.test(agent) ? "Firefox" : /(?:Chrome|CriOS)\//.test(agent) ? "Chrome"
      : /Safari\//.test(agent) ? "Safari" : "Browser"
  const platform = /iPhone|iPad|iPod/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android"
    : /Windows/.test(agent) ? "Windows" : /Macintosh|Mac OS X/.test(agent) ? "macOS"
      : /Linux/.test(agent) ? "Linux" : "Unknown device"
  return { browser, platform }
}

const timestamp = (value: number | string) => typeof value === "number" ? value : new Date(value).getTime()

export function browserCommandActivity(message: string | Buffer) {
  try {
    const value = JSON.parse(typeof message === "string" ? message : message.toString())
    return value?.type === "command" && typeof value.command?.type === "string" && value.command.type !== "system.ping"
  } catch { return false }
}

export class BrowserSessions {
  constructor(private db: Database, private activityDb: Database, private isRevoked: (id: string) => boolean, private now = Date.now) {
    // Separate from Better Auth's schema; old logins have unknown last use until
    // the browser next makes an authenticated request. No invented history.
    activityDb.exec(`CREATE TABLE IF NOT EXISTS connect_session_activity (
      sessionId TEXT PRIMARY KEY,
      lastUsedAt INTEGER NOT NULL
    )`)
    const live = new Set(db.query<{ id: string }, []>("SELECT id FROM session").all().map(row => row.id))
    for (const row of activityDb.query<{ sessionId: string }, []>("SELECT sessionId FROM connect_session_activity").all()) {
      if (!live.has(row.sessionId)) this.forget(row.sessionId)
    }
  }

  forget(id: string) { this.activityDb.query("DELETE FROM connect_session_activity WHERE sessionId=?").run(id) }

  touch(id: string) {
    const now = this.now()
    this.activityDb.query(`INSERT INTO connect_session_activity(sessionId,lastUsedAt) VALUES (?,?)
      ON CONFLICT(sessionId) DO UPDATE SET lastUsedAt=excluded.lastUsedAt
      WHERE connect_session_activity.lastUsedAt <= ?`).run(id, now, now - 60_000)
  }

  list(ownerId: string, currentId?: string): ConnectBrowserSessions {
    const now = this.now()
    const rows = this.db.query<{
      id: string; createdAt: number | string; expiresAt: number | string; userAgent: string | null
    }, [string]>("SELECT id,createdAt,expiresAt,userAgent FROM session WHERE userId=?").all(ownerId)
    const sessions = rows.filter(row => timestamp(row.expiresAt) > now && !this.isRevoked(row.id)).map(row => ({
      id: row.id, ...browserDescription(row.userAgent), createdAt: timestamp(row.createdAt),
      expiresAt: timestamp(row.expiresAt), lastUsedAt: this.activityDb.query<{ lastUsedAt: number }, [string]>("SELECT lastUsedAt FROM connect_session_activity WHERE sessionId=?").get(row.id)?.lastUsedAt ?? null, current: row.id === currentId,
    })).sort((a, b) => Number(b.current) - Number(a.current) || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt) || a.id.localeCompare(b.id))
    return { sessions, now }
  }
}
