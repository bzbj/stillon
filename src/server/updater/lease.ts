import { randomUUID } from "node:crypto"
import { mkdir, rename, rmdir, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { atomicJson } from "./files"
import { leaseAlive } from "./control"
import type { UpdateDeployment } from "./model"

export async function withWorkerLease(deployment: UpdateDeployment, work: () => Promise<void>) {
  const root = deployment.root
  // OS task/LaunchAgent serializes invocations; a live lease additionally rejects
  // accidental direct invocations. A process cannot impersonate a dead lease by PID reuse.
  if (await leaseAlive(root)) return
  const lock = path.join(root, "worker.lock")
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (Date.now() - (await stat(lock)).mtimeMs < 30_000) return
    if (await leaseAlive(root)) return
    await rename(lock, path.join(root, `stale-worker-lock-${randomUUID()}`))
    await mkdir(lock, { mode: 0o700 })
  }
  const token = randomUUID()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request) { return request.headers.get("authorization") === `Bearer ${token}`
      ? new Response(token) : new Response(null, { status: 403 }) } })
  try {
    await atomicJson(path.join(root, "lease.json"), { port: server.port, token })
    await work()
  } finally {
    server.stop(true)
    await unlink(path.join(root, "lease.json")).catch(() => {})
    // Only remove our empty lock, never recursively remove a transaction or backup.
    await rmdir(lock)
  }
}
