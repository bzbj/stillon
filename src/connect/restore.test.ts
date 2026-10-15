import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { Database } from "bun:sqlite"
import path from "node:path"
import { createConnectService } from "./service"
import { restoreConnectBackup } from "./restore"
import { newDeviceKeys, randomToken } from "../server/connect/crypto"
import { ConnectRegistry } from "./registry"

test("restoring a backup cannot resurrect the backed-up device or browser session", async () => {
  await mkdir("test-artifacts/connect", { recursive: true })
  const directory = await mkdtemp(path.resolve("test-artifacts/connect/restore-")), source = path.join(directory, "source"), destination = path.join(directory, "restored")
  const origin = "https://connect.stillon.example", secret = randomToken()
  const service = await createConnectService({ origin, secret, dataDir: source, sender: { async send() {} }, transport: { upstreamOrigin: "http://127.0.0.1:9" } })
  const key = newDeviceKeys(), enrollment = service.registry.createEnrollment(key.publicKey, "Computer")
  service.registry.approveEnrollment(enrollment.id, { id: "parent", userId: "owner", email: "owner@example.com", expiresAt: Date.now() + 60_000 })
  const host = service.registry.claimEnrollment(enrollment.id, key.publicKey)!
  service.close()
  try {
    // Recovery accepts only a checkpointed, stopped backup. Better Auth's
    // migration connection can leave a WAL file until its explicit checkpoint.
    for (const name of ["auth.sqlite", "hosts.sqlite"]) {
      const db = new Database(path.join(source, name))
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)") } finally { db.close() }
    }
    await restoreConnectBackup(source, destination)
    const registry = new ConnectRegistry(destination, origin, randomToken())
    try { expect(() => registry.requireHost(host.id)).toThrow("NOT_FOUND"); expect(registry.hosts("owner")).toHaveLength(0) } finally { registry.close() }
    const db = new Database(path.join(destination, "auth.sqlite"))
    try { expect((db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(0) } finally { db.close() }
    expect(await Bun.file(path.join(destination, "gateway-keys.json")).exists()).toBe(false)
    await expect(restoreConnectBackup(source, destination)).rejects.toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
