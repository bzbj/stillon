import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager } from "./app-settings"
import { startStillOnServer } from "./server"

test("whole-sidebar choices survive reload and reject invalid mixed patches atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-sidebar-view-"))
  const file = path.join(root, "settings.json")
  const settings = new AppSettingsManager(file)
  try {
    await settings.initialize()
    await settings.writePatch({ sidebarCollapsed: true, workspaceCollapsed: { a: true } })
    expect(JSON.parse(await readFile(file, "utf8")).sidebarCollapsed).toBe(true)
    const before = await readFile(file, "utf8")
    await expect(settings.writePatch({ sidebarCollapsed: "false", workspaceCollapsed: { a: false } } as never)).rejects.toThrow("true or false")
    expect(await readFile(file, "utf8")).toBe(before)
    settings.dispose()
    const reloaded = new AppSettingsManager(file)
    try {
      await reloaded.initialize()
      expect(reloaded.getSnapshot().sidebarCollapsed).toBe(true)
      await reloaded.writePatch({ sidebarCollapsed: false, theme: "dark" })
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ sidebarCollapsed: false, workspaceCollapsed: { a: true }, theme: "dark" })
    } finally { reloaded.dispose() }
  } finally { settings.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("initial sidebar view is authenticated, uncached and excludes unrelated settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-sidebar-bootstrap-"))
  await writeFile(path.join(root, "settings.json"), JSON.stringify({ machineName: "Sample computer", sidebarCollapsed: true, workspaceCollapsed: { a: true, b: false } }))
  const server = await startStillOnServer({ dataDir: root, discoveryHome: root, port: 0, openBrowser: false,
    password: "test-password", codexModelDiscovery: { discover: async () => { throw new Error("Disabled in test") } } })
  const origin = `http://127.0.0.1:${server.port}`
  try {
    const denied = await fetch(origin + "/api/sidebar-view")
    expect(denied.status).toBe(401); await denied.text()
    const login = await fetch(origin + "/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password" }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!
    await login.text()
    const response = await fetch(origin + "/api/sidebar-view", { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ machineName: "Sample computer", sidebarCollapsed: true, workspaceCollapsed: { a: true, b: false } })
    const post = await fetch(origin + "/api/sidebar-view", { method: "POST", headers: { Cookie: cookie, Origin: origin } })
    expect(post.status).toBe(405); await post.text()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)
