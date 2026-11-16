import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { Schedule, ScheduleRun } from "../shared/schedules"
import { nextScheduleTime } from "./schedule-time"

type Row = { record: string }
/** Separate from chat v2 snapshots, so an older app cannot compact plans away. */
export class ScheduleStore {
  readonly db: Database
  private guard?: Database
  readonly writable: boolean
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const file = path.join(dataDir, "schedules.sqlite")
    this.db = new Database(file, { create: true, strict: true })
    try {
      chmodSync(file, 0o600)
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      if (version > 1) throw new Error("Schedules require a newer StillOn version")
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS operation(id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS schedule(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS run(id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, project_id TEXT NOT NULL, occurrence TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(schedule_id,occurrence)); PRAGMA user_version=1;")
      // SQLite releases this OS lock on process death. Never infer death from a heartbeat.
      const guardPath = path.join(dataDir, "scheduler-lock.sqlite")
      try {
        this.guard = new Database(guardPath, { create: true })
        chmodSync(guardPath, 0o600)
        this.guard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")
        this.writable = true
      } catch { this.guard?.close(); this.guard = undefined; this.writable = false }
      if (this.writable) this.recover()
    } catch (error) { this.guard?.close(); this.db.close(); throw error }
  }
  private requireWriter() { if (!this.writable) throw new Error("Another StillOn process owns this scheduler") }
  operation(id: string, payload: string, execute: () => unknown) {
    this.requireWriter()
    return this.db.transaction(() => {
      const old = this.db.query<{ payload: string; result: string }, [string]>("SELECT payload,result FROM operation WHERE id=?").get(id)
      if (old) {
        if (old.payload !== payload) throw new Error("Operation id already used with different arguments")
        return JSON.parse(old.result)
      }
      const result = execute()
      this.db.query("INSERT INTO operation VALUES(?,?,?,?)").run(id, payload, JSON.stringify(result), Date.now())
      return result
    }).immediate()
  }
  get(id: string): Schedule | null {
    const row = this.db.query<Row, [string]>("SELECT record FROM schedule WHERE id=?").get(id)
    return row ? JSON.parse(row.record) : null
  }
  list(projectId?: string): Schedule[] {
    const rows = projectId ? this.db.query<Row, [string]>("SELECT record FROM schedule WHERE project_id=?").all(projectId) : this.db.query<Row, []>("SELECT record FROM schedule").all()
    return rows.map(row => JSON.parse(row.record) as Schedule).sort((a, b) => a.createdAt - b.createdAt)
  }
  save(schedule: Schedule, expectedRevision?: number) {
    this.requireWriter()
    return this.db.transaction(() => {
      const old = this.get(schedule.id)
      if (expectedRevision !== undefined && old?.revision !== expectedRevision) throw new Error("Schedule changed; refresh and retry")
      this.db.query("INSERT OR REPLACE INTO schedule VALUES(?,?,?)").run(schedule.id, schedule.projectId, JSON.stringify(schedule))
      return schedule
    }).immediate()
  }
  delete(id: string, revision: number) {
    this.requireWriter()
    this.db.transaction(() => {
      if (this.get(id)?.revision !== revision) throw new Error("Schedule changed; refresh and retry")
      this.db.query("DELETE FROM schedule WHERE id=?").run(id)
    }).immediate()
  }
  runs(projectId: string): ScheduleRun[] {
    return this.db.query<Row, [string]>("SELECT record FROM run WHERE project_id=? ORDER BY CASE WHEN json_extract(record,'$.state') IN ('claimed','running','waiting_for_user') THEN 0 ELSE 1 END, rowid DESC LIMIT 200").all(projectId).map(row => JSON.parse(row.record))
  }
  claim(id: string, now: number, cwd: string): ScheduleRun | null {
    this.requireWriter()
    return this.db.transaction(() => {
      const schedule = this.get(id)
      if (!schedule?.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) return null
      const run: ScheduleRun = { id: crypto.randomUUID(), scheduleId: id, projectId: schedule.projectId, chatId: schedule.chatId, name: schedule.name, scheduledFor: schedule.nextRunAt, state: "claimed", execution: schedule.execution, cwd }
      const result = this.db.query("INSERT OR IGNORE INTO run VALUES(?,?,?,?,?)").run(run.id, id, run.projectId, String(run.scheduledFor), JSON.stringify(run))
      if (!result.changes) return null
      const nextRunAt = nextScheduleTime(schedule.trigger, now)
      this.save({ ...schedule, nextRunAt, enabled: nextRunAt !== null, updatedAt: now, revision: schedule.revision + 1 })
      return run
    }).immediate()
  }
  updateRun(run: ScheduleRun) {
    this.requireWriter()
    this.db.query("UPDATE run SET record=? WHERE id=?").run(JSON.stringify(run), run.id)
    // Keep history bounded, including plans which were deleted.
    this.db.query("DELETE FROM run WHERE project_id=? AND json_extract(record,'$.state') NOT IN ('claimed','running','waiting_for_user') AND rowid NOT IN (SELECT rowid FROM run WHERE project_id=? ORDER BY rowid DESC LIMIT 200)").run(run.projectId, run.projectId)
  }
  private recover() {
    this.db.transaction(() => {
      for (const row of this.db.query<Row, []>("SELECT record FROM run").all()) {
        const run = JSON.parse(row.record) as ScheduleRun
        if (!["claimed", "running", "waiting_for_user"].includes(run.state)) continue
        this.updateRun({ ...run, state: "interrupted_unknown", finishedAt: Date.now(), reason: "StillOn restarted; inspect the conversation before resuming. This run will not replay." })
        const schedule = this.get(run.scheduleId)
        if (schedule) this.save({ ...schedule, enabled: false, revision: schedule.revision + 1, issue: "Previous run interrupted; review and resume" })
      }
    }).immediate()
  }
  close() { this.guard?.close(); this.guard = undefined; this.db.close() }
}
