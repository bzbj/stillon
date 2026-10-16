import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { createConnectService } from "../../connect/service"
import { ConnectorError, createConnector } from "./connector"
import { randomToken } from "./crypto"

test("offline enrollment cancellation survives restart and diagnostics omit private state", async () => {
  await mkdir("test-artifacts/connect", { recursive: true })
  const root = await mkdtemp(path.resolve("test-artifacts/connect/cancel-"))
  let available = true
  let service: Awaited<ReturnType<typeof createConnectService>>
  const active = new Set<Promise<unknown>>()
  const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (!available) return Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 })
    const operation = service.central(request, "127.0.0.1").then(value => value ?? new Response(null, { status: 404 }))
    active.add(operation); void operation.finally(() => active.delete(operation)).catch(() => {})
    return operation
  } })
  const origin = `http://localhost:${cloud.port}`
  service = await createConnectService({ origin, dataDir: path.join(root, "cloud"), secret: randomToken(),
    sender: { async send() { throw new Error("Mail is not needed in this test") } }, transport: { upstreamOrigin: "http://127.0.0.1:9" } })
  const options = { dataDir: path.join(root, "computer"), origin, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(),
    name: () => "Private computer name", frpcPath: process.execPath }
  let connector = await createConnector(options)
  async function action<T>(run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5_000
    for (;;) {
      try { return await run() } catch (error) {
        if (!(error instanceof ConnectorError && error.code === "BUSY") || Date.now() >= deadline) throw error
        await Bun.sleep(50)
      }
    }
  }
  try {
    const pending = await action(() => connector.enroll())
    const saved = JSON.parse(await readFile(path.join(options.dataDir, "connect/device.json"), "utf8"))
    const diagnostic = JSON.stringify(connector.diagnostics())
    for (const value of [saved.keys.privateKey, saved.keys.publicKey, root, origin, pending.id, options.localSecret, options.name()]) expect(diagnostic).not.toContain(value)
    expect(connector.diagnostics()).toMatchObject({ state: "pending", bound: false, transportRunning: false, protocol: 1 })
    available = false
    await action(() => connector.unbind())
    expect(connector.status().state).toBe("revocation-pending")
    await expect(action(() => connector.enroll())).rejects.toThrow("CLOUD_UPDATE_PENDING")
    await connector.stop()
    available = true
    connector = await createConnector(options)
    const deadline = Date.now() + 5_000
    while (connector.status().state !== "unbound" && Date.now() < deadline) await Bun.sleep(50)
    expect(connector.status().state).toBe("unbound")
    expect(() => service.registry.pendingEnrollment(pending.id)).toThrow("BINDING_EXPIRED")
    expect(await Bun.file(path.join(options.dataDir, "connect/device.json")).exists()).toBe(false)
    const replacement = await action(() => connector.enroll())
    expect(replacement.id).not.toBe(pending.id)
    await action(() => connector.unbind())
    expect(connector.status().state).toBe("unbound")
  } finally {
    await connector.stop(); await cloud.stop(true); await Promise.allSettled([...active]); service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
