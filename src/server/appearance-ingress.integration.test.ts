import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { APPEARANCE_FIXTURE_PNG } from "../../scripts/appearance-fixture"
import { startStillOnServer } from "./server"

const publicOrigins = ["https://stillon.example.com", "https://other.example.com"]
const skin = JSON.stringify({ format: "stillon-skin", themeApi: 1, uiApi: 1, name: "Sample skin", appearance: { palette: "forest" } })

test("appearance uploads accept declared HTTPS proxies and reject untrusted writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-appearance-ingress-"))
  const server = await startStillOnServer({ dataDir: root, discoveryHome: root, port: 0, openBrowser: false,
    trustProxy: true, allowedOrigins: publicOrigins,
    codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
  const origin = `http://127.0.0.1:${server.port}`
  try {
    for (const route of ["background", "skins/import"]) {
      const body = route === "background" ? APPEARANCE_FIXTURE_PNG : skin
      const local = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body, headers: { origin } })
      expect(local.status).toBe(200)
      const expected = await local.json()
      for (const publicOrigin of publicOrigins) {
        const headers = { host: new URL(publicOrigin).host, origin: publicOrigin, "x-forwarded-proto": "https" }
        const uploaded = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body, headers })
        expect(uploaded.status).toBe(200)
        expect(await uploaded.json()).toEqual(expected)
        for (const denied of [
          { ...headers, origin: "https://untrusted.example" }, { ...headers, origin: "null" },
          { ...headers, "sec-fetch-site": "cross-site" }, { ...headers, host: "untrusted.example" },
          { host: headers.host },
        ]) {
          const response = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body, headers: denied })
          expect(response.status).toBe(403)
          await response.text()
        }
        const invalid = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body: "invalid", headers })
        expect(invalid.status).toBe(400)
        expect(typeof (await invalid.json()).error).toBe("string")
      }
      if (route === "background") {
        const asset = await fetch(`${origin}/api/appearance/assets/${expected.asset}`)
        expect(Buffer.from(await asset.arrayBuffer())).toEqual(APPEARANCE_FIXTURE_PNG)
      }
    }
    // Upload/import only stages a preview; neither applies appearance settings.
    const exported = await fetch(`${origin}/api/appearance/skin/export`)
    expect((await exported.json()).background).toBeUndefined()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)

test("the app password still protects appearance imports through HTTPS proxies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-appearance-auth-"))
  const server = await startStillOnServer({ dataDir: root, discoveryHome: root, port: 0, openBrowser: false,
    password: "test-only-password", trustProxy: true, allowedOrigins: publicOrigins,
    codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
  const origin = `http://127.0.0.1:${server.port}`
  const headers = { host: new URL(publicOrigins[0]!).host, origin: publicOrigins[0]!, "x-forwarded-proto": "https", "content-type": "application/json" }
  try {
    for (const route of ["background", "skins/import"]) {
      const denied = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body: skin, headers })
      expect(denied.status).toBe(401)
      await denied.text()
    }
    const login = await fetch(origin + "/auth/login", { method: "POST", body: JSON.stringify({ password: "test-only-password" }), headers })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!
    await login.text()
    for (const route of ["background", "skins/import"]) {
      const saved = await fetch(`${origin}/api/appearance/${route}`, { method: "POST", body: route === "background" ? APPEARANCE_FIXTURE_PNG : skin, headers: { ...headers, cookie } })
      expect(saved.status).toBe(200)
      await saved.json()
    }
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)
