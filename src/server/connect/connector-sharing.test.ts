import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createConnector } from "./connector"
import { newDeviceKeys, randomToken } from "./crypto"
import { SHARING_REFRESH_MS } from "../../shared/sharing-cache"

test("connector shares five-minute metadata across local/remote readers and refreshes after mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-sharing-cache-"))
  let clock = Date.now(), lists = 0, title = "initial"
  const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json()
    if (new URL(request.url).pathname.endsWith("/challenge")) return Response.json({ challenge: "fixture-challenge" })
    if (body.action !== "workspace-sharing") return Response.json({ success: true })
    const snapshot = () => ({ workspaces: [{ workspaceId: "sample", title, members: [] }] })
    if (body.payload.operation === "list") { lists++; await Bun.sleep(20); return Response.json(snapshot()) }
    title = "changed"
    return body.payload.operation === "invite" ? Response.json({ invitationUrl: "https://example.invalid/invite" }) : Response.json(snapshot())
  } })
  let connector: Awaited<ReturnType<typeof createConnector>> | undefined
  try {
    const directory = path.join(root, "connect"), keys = newDeviceKeys()
    await mkdir(directory)
    await writeFile(path.join(directory, "device.json"), JSON.stringify({ version: 1, origin: `http://localhost:${cloud.port}`, keys, name: "Fixture", paused: true,
      binding: { hostId: "a".repeat(32), name: "Fixture", email: "fixture@example.com", epoch: 1, gatewayPublicKey: keys.publicKey, url: `http://localhost:${cloud.port}` } }))
    connector = await createConnector({ dataDir: root, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Fixture", frpcPath: process.execPath, now: () => clock })
    const reads = await Promise.all(Array.from({ length: 10 }, () => connector!.workspaceSharing({ operation: "list" })))
    expect(lists).toBe(1); expect(reads.every(r => r.workspaces[0]?.title === "initial")).toBe(true)
    clock += SHARING_REFRESH_MS - 1
    await connector.workspaceSharing({ operation: "list" }); expect(lists).toBe(1)
    await connector.workspaceSharing({ operation: "list" }, true); expect(lists).toBe(2)
    await connector.workspaceSharing({ operation: "remove", workspaceId: "sample", memberId: "b".repeat(32) })
    expect((await connector.workspaceSharing({ operation: "list" })).workspaces[0]?.title).toBe("changed")
    expect(lists).toBe(2)
    await connector.workspaceSharing({ operation: "invite", workspaceId: "sample" }); expect(lists).toBe(3)
    clock += SHARING_REFRESH_MS
    await connector.workspaceSharing({ operation: "list" }); expect(lists).toBe(4)
  } finally {
    await connector?.stop(); await cloud.stop(true); await rm(root, { recursive: true, force: true })
  }
})
