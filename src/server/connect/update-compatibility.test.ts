import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { startStillOnServer } from "../server"
import { randomToken } from "./crypto"

test("Connect ingress does not count the updater's own check as active work", async () => {
  await mkdir("test-artifacts/connect", { recursive: true })
  const directory = await mkdtemp(path.resolve("test-artifacts/connect/update-"))
  const keys = ["STILLON_UPDATE_INSTANCE", "STILLON_UPDATE_SECRET", "STILLON_UPDATE_VERIFYING"] as const
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const secret = randomToken()
  process.env.STILLON_UPDATE_INSTANCE = "isolated-connect-update-test"
  process.env.STILLON_UPDATE_SECRET = secret
  process.env.STILLON_UPDATE_VERIFYING = "0"
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  try {
    server = await startStillOnServer({ dataDir: directory, discoveryHome: directory, port: 0, strictPort: true,
      codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
    const origin = `http://127.0.0.1:${server.port}`
    let response: Response | undefined
    for (let i = 0; i < 50; i++) {
      response = await fetch(`${origin}/_stillon/update/check`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })
      if (response.ok) break
      await Bun.sleep(50)
    }
    expect(response!.status).toBe(200)
    expect(await response!.json()).toEqual({ busy: false })
    expect((await fetch(`${origin}/_stillon/update/check`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, Origin: "https://evil.example" } })).status).toBe(403)
    expect((await fetch(`${origin}/_stillon/update/check`, { method: "POST" })).status).toBe(403)
  } finally {
    await server?.stop()
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
