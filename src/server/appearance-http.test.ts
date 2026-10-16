import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { APPEARANCE_FIXTURE_PNG } from "../../scripts/appearance-fixture"
import { startStillOnServer } from "./server"
import { readAppSettingsSnapshot } from "./app-settings"

test("appearance routes use real server authentication and do not apply uploads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-appearance-http-"))
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!; await reservation.stop(true)
  const server = await startStillOnServer({ dataDir, port, strictPort: true, openBrowser: false, password: "test-only-password" })
  const origin = `http://127.0.0.1:${port}`
  try {
    const uploadedWithoutAuth = await fetch(`${origin}/api/appearance/background`, { method: "POST", body: APPEARANCE_FIXTURE_PNG, headers: { Origin: origin } })
    expect(uploadedWithoutAuth.status).toBe(401)
    const login = await fetch(`${origin}/auth/login`, { method: "POST", body: JSON.stringify({ password: "test-only-password" }), headers: { "Content-Type": "application/json", Origin: origin } })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!
    const forbidden = await fetch(`${origin}/api/appearance/background`, { method: "POST", body: APPEARANCE_FIXTURE_PNG, headers: { Cookie: cookie, Origin: "https://evil.example" } })
    expect(forbidden.status).toBe(403)
    const before = await readAppSettingsSnapshot(path.join(dataDir, "settings.json"))
    const upload = await fetch(`${origin}/api/appearance/background`, { method: "POST", body: APPEARANCE_FIXTURE_PNG, headers: { Cookie: cookie, Origin: origin } })
    expect(upload.status).toBe(200)
    const { asset } = await upload.json()
    expect((await readAppSettingsSnapshot(path.join(dataDir, "settings.json"))).appearance).toEqual(before.appearance)
    expect((await fetch(`${origin}/api/appearance/assets/${asset}`)).status).toBe(401)
    const image = await fetch(`${origin}/api/appearance/assets/${asset}`, { headers: { Cookie: cookie } })
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(APPEARANCE_FIXTURE_PNG)
    expect((await fetch(`${origin}/api/appearance/skin/export`)).status).toBe(401)
    const exported = await fetch(`${origin}/api/appearance/skin/export`, { headers: { Cookie: cookie } })
    expect(exported.status).toBe(200)
    expect((await exported.json()).format).toBe("stillon-skin")
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }) }
}, 60_000)
