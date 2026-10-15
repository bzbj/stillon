import { createHmac, timingSafeEqual } from "node:crypto"
import type { Database } from "bun:sqlite"
import { CONNECT_OTP_SECONDS } from "./shared"

export interface LoginBudget {
  key: string
  max: number
  windowSeconds: number
}

export class LoginGuard {
  constructor(private db: Database, private secret: string, private now = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connect_rate_event (key TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS connect_rate_lookup ON connect_rate_event (key, at);
      CREATE TABLE IF NOT EXISTS connect_challenge (
        id TEXT PRIMARY KEY,
        email_key TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connect_challenge_email ON connect_challenge (email_key);
    `)
  }

  digest(...parts: string[]) {
    return createHmac("sha256", this.secret).update(JSON.stringify(parts)).digest("hex")
  }

  /** Reserve every applicable rolling budget in one SQLite write transaction. */
  consume(budgets: LoginBudget[]): number | null {
    return this.db.transaction(() => {
      const now = this.now()
      this.db.query("DELETE FROM connect_rate_event WHERE at <= ?").run(now - 24 * 60 * 60 * 1_000)
      this.db.query("DELETE FROM connect_challenge WHERE expires_at <= ?").run(now)
      let retryAfter = 0
      for (const budget of budgets) {
        const rows = this.db.query<{ at: number }, [string, number]>(
          "SELECT at FROM connect_rate_event WHERE key = ? AND at > ? ORDER BY at",
        ).all(budget.key, now - budget.windowSeconds * 1_000)
        if (rows.length >= budget.max) {
          const availableAt = rows[rows.length - budget.max]!.at + budget.windowSeconds * 1_000
          retryAfter = Math.max(retryAfter, Math.ceil((availableAt - now) / 1_000))
        }
      }
      if (retryAfter > 0) return retryAfter
      const insert = this.db.query("INSERT INTO connect_rate_event (key, at) VALUES (?, ?)")
      for (const budget of budgets) insert.run(budget.key, now)
      return null
    }).immediate()
  }

  issue(challenge: string, email: string, code: string, intent = "sign-in") {
    this.db.transaction(() => {
      // Better Auth rotates the email's code; invalidate the old browser receipt too.
      this.db.query("DELETE FROM connect_challenge WHERE email_key = ?").run(this.digest("email", email))
      this.db.query("INSERT INTO connect_challenge (id, email_key, code_hash, expires_at) VALUES (?, ?, ?, ?)").run(
        this.digest("challenge", challenge), this.digest("email", email),
        this.digest("receipt", challenge, email, code, intent), this.now() + CONNECT_OTP_SECONDS * 1_000,
      )
    }).immediate()
  }

  /** A correct receipt can be claimed once, including concurrent HTTP requests. */
  claim(challenge: string, email: string, code: string, intent = "sign-in") {
    return this.db.transaction(() => {
      const id = this.digest("challenge", challenge)
      const row = this.db.query<{ code_hash: string; expires_at: number }, [string, string]>(
        "SELECT code_hash, expires_at FROM connect_challenge WHERE id = ? AND email_key = ?",
      ).get(id, this.digest("email", email))
      if (!row || row.expires_at <= this.now()) return false
      const expected = Buffer.from(row.code_hash, "hex")
      const actual = Buffer.from(this.digest("receipt", challenge, email, code, intent), "hex")
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
      this.db.query("DELETE FROM connect_challenge WHERE id = ?").run(id)
      return true
    }).immediate()
  }
}
