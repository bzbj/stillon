import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startStillOnServer } from "./server"
import { WorkspaceAvatarsManager } from "./workspace-avatars"

const publicOrigin = "https://stillon.example.com"

test("an explicitly configured HTTPS proxy can save avatars without the optional app password", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-avatar-ingress-"))
  const server = await startStillOnServer({ dataDir: root, discoveryHome: root, port: 0, openBrowser: false,
    trustProxy: true, allowedOrigins: [publicOrigin],
    codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
  const localOrigin = `http://127.0.0.1:${server.port}`
  const endpoint = localOrigin + "/api/appearance/avatars"
  try {
    const workspace = await server.store.openProject(root, "Sample workspace")
    const body = JSON.stringify({ workspaceId: workspace.id, shape: "pebble", color: "#3d7ff5" })
    const local = await fetch(endpoint, { method: "POST", body, headers: { origin: localOrigin, "content-type": "application/json" } })
    expect(local.status).toBe(200)
    await local.json()
    const proxyHeaders = { host: new URL(publicOrigin).host, origin: publicOrigin, "x-forwarded-proto": "https", "content-type": "application/json" }
    const proxied = await fetch(endpoint, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, shape: "drop", color: "#abcdef" }), headers: proxyHeaders })
    expect(proxied.status).toBe(200)
    expect((await proxied.json()).config.workspaces[workspace.id]).toEqual({ shape: "drop", color: "#abcdef" })
    expect((await new WorkspaceAvatarsManager(root).snapshot()).config.workspaces[workspace.id]).toEqual({ shape: "drop", color: "#abcdef" })
    const reloaded = await fetch(endpoint, { headers: { host: new URL(publicOrigin).host } })
    expect((await reloaded.json()).config.workspaces[workspace.id]).toEqual({ shape: "drop", color: "#abcdef" })

    const deniedHeaders: Record<string, string>[] = [
      { ...proxyHeaders, origin: "https://untrusted.example" },
      { ...proxyHeaders, origin: "null" },
      { ...proxyHeaders, "sec-fetch-site": "cross-site" },
      { ...proxyHeaders, host: "untrusted.example" },
      { host: new URL(publicOrigin).host, "content-type": "application/json" },
    ]
    for (const headers of deniedHeaders) {
      const denied = await fetch(endpoint, { method: "POST", body, headers })
      expect(denied.status).toBe(403)
      await denied.text()
    }
    const unknown = await fetch(endpoint, { method: "POST", body: JSON.stringify({ workspaceId: "unknown", shape: "round", color: "#112233" }), headers: proxyHeaders })
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).error).toBe("Workspace not found.")
    expect((await new WorkspaceAvatarsManager(root).snapshot()).config.workspaces[workspace.id]).toEqual({ shape: "drop", color: "#abcdef" })
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)

test("the optional app password still protects avatar writes behind an HTTPS proxy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-avatar-auth-"))
  const server = await startStillOnServer({ dataDir: root, discoveryHome: root, port: 0, openBrowser: false,
    password: "test-only-password", trustProxy: true, allowedOrigins: [publicOrigin],
    codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
  const origin = `http://127.0.0.1:${server.port}`
  const headers = { host: new URL(publicOrigin).host, origin: publicOrigin, "x-forwarded-proto": "https", "content-type": "application/json" }
  try {
    const workspace = await server.store.openProject(root, "Sample workspace")
    const body = JSON.stringify({ workspaceId: workspace.id, shape: "pebble", color: "#3d7ff5" })
    const denied = await fetch(origin + "/api/appearance/avatars", { method: "POST", body, headers })
    expect(denied.status).toBe(401)
    await denied.text()
    const login = await fetch(origin + "/auth/login", { method: "POST", body: JSON.stringify({ password: "test-only-password" }), headers })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!
    await login.text()
    const saved = await fetch(origin + "/api/appearance/avatars", { method: "POST", body, headers: { ...headers, cookie } })
    expect(saved.status).toBe(200)
    expect((await saved.json()).config.workspaces[workspace.id]).toEqual({ shape: "pebble", color: "#3d7ff5" })
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)
