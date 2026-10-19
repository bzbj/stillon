import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createConnector } from "./connector"
import { randomToken } from "./crypto"

test("a migrated user service origin works without a package default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-origin-migration-"))
  try {
    const dataDir = path.join(root, "data")
    await mkdir(path.join(dataDir, "connect"), { recursive: true })
    await writeFile(path.join(dataDir, "connect/service.json"), JSON.stringify({ origin: "https://connect.example.invalid" }))
    const connector = await createConnector({ dataDir, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Migrated computer" })
    try { expect(connector.status().origin).toBe("https://connect.example.invalid") }
    finally { await connector.stop() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
