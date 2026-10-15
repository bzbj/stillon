import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { hashToken } from "./crypto"
import type { ClientCommand, ServerEnvelope } from "../../shared/protocol"

const RETENTION_MS = 24 * 60 * 60_000
interface Operation { owner: string; id: string; digest: string; state: "pending" | "complete" | "unknown"; response: string | null; createdAt: number }

/** A durable at-most-once receipt. A crash never causes an external action to
 * replay automatically; an unfinished receipt becomes RESULT_UNKNOWN. */
export class RemoteOperations {
  private readonly db: Database
  constructor(dataDir: string, private readonly now = Date.now) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const file = path.join(dataDir, "remote-operations.sqlite")
    this.db = new Database(file, { create: true, strict: true }); chmodSync(file, 0o600)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operation (owner TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,response TEXT,createdAt INTEGER NOT NULL,PRIMARY KEY(owner,id)); UPDATE operation SET state='unknown' WHERE state='pending';")
  }
  private validId(id: string) {
    if (!/^\d{13}-[\w-]{16,80}$/.test(id)) throw new Error("INVALID_OPERATION_ID")
    const time = Number(id.slice(0, 13))
    if (time > this.now() + 5_000 || this.now() - time >= RETENTION_MS) throw new Error("OPERATION_EXPIRED")
  }
  get(owner: string, id: string) {
    this.validId(id)
    const row = this.db.query<Operation, [string, string]>("SELECT * FROM operation WHERE owner=? AND id=?").get(owner, id)
    return row ? { state: row.state, response: row.response ? JSON.parse(row.response) as ServerEnvelope : null } : null
  }
  begin(owner: string, id: string, command: ClientCommand): ServerEnvelope | null {
    this.validId(id)
    const digest = hashToken(JSON.stringify(command))
    return this.db.transaction((): ServerEnvelope | null => {
      this.db.query("DELETE FROM operation WHERE createdAt<=?").run(this.now() - RETENTION_MS)
      const old = this.db.query<Operation, [string, string]>("SELECT * FROM operation WHERE owner=? AND id=?").get(owner, id)
      if (old) {
        if (old.digest !== digest) throw new Error("OPERATION_CONFLICT")
        return old.response ? JSON.parse(old.response) as ServerEnvelope
          : { v: 1, type: "error", id, message: old.state === "pending" ? "RESULT_PENDING: 操作正在处理，请勿重复提交。" : "RESULT_UNKNOWN: 请先检查任务状态，不会自动重放这个操作。" }
      }
      this.db.query("INSERT INTO operation VALUES (?,?,?,'pending',NULL,?)").run(owner, id, digest, this.now())
      return null
    }).immediate()
  }
  finish(owner: string, response: ServerEnvelope) {
    if ((response.type !== "ack" && response.type !== "error") || !response.id) return
    const encoded = JSON.stringify(response)
    if (encoded.length > 1_048_576) { this.db.query("UPDATE operation SET state='unknown' WHERE owner=? AND id=? AND state='pending'").run(owner, response.id); return }
    this.db.query("UPDATE operation SET state='complete',response=? WHERE owner=? AND id=? AND state='pending'").run(encoded, owner, response.id)
  }
  close() { this.db.close() }
}
