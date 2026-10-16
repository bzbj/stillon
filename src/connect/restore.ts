import { Database } from "bun:sqlite"
import { copyFile, mkdir, stat, chmod } from "node:fs/promises"
import path from "node:path"

/** Restore a stopped, checkpointed backup into a NEW directory. Deliberately
 * retire every device and session: an older backup cannot resurrect an access
 * revocation that happened after the backup. Users bind their computers again. */
export async function restoreConnectBackup(source: string, destination: string) {
  const names = ["auth.sqlite", "hosts.sqlite"]
  for (const name of names) {
    if (!(await stat(path.join(source, name))).isFile()) throw new Error("Incomplete Connect backup")
    try { if ((await stat(path.join(source, `${name}-wal`))).size) throw new Error("Backup must be stopped and checkpointed") }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
  }
  await mkdir(destination, { mode: 0o700 }) // refuses an existing destination
  for (const name of names) { await copyFile(path.join(source, name), path.join(destination, name)); await chmod(path.join(destination, name), 0o600) }
  const auth = new Database(path.join(destination, "auth.sqlite"))
  const hosts = new Database(path.join(destination, "hosts.sqlite"))
  try {
    auth.exec("DELETE FROM session; DELETE FROM verification; PRAGMA wal_checkpoint(TRUNCATE);")
    hosts.transaction(() => {
      hosts.query("UPDATE host SET revokedAt=?,epoch=epoch+1").run(Date.now())
      hosts.exec("DELETE FROM host_session; DELETE FROM auth_flow; DELETE FROM connection; DELETE FROM device_challenge; DELETE FROM enrollment;")
    }).immediate()
    hosts.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally { auth.close(); hosts.close() }
  // No old OTP receipts or gateway signing keys are copied. Fresh ones are
  // created on startup; the operator also supplies a new account secret.
}
