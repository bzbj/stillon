import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager } from "./app-settings"
import { startStillOnServer } from "./server"

test("workspace versions reject stale writes atomically, including a change back to the old value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-sidebar-view-"))
  const file = path.join(root, "settings.json")
  const settings = new AppSettingsManager(file)
  try {
    await settings.initialize()
    const initial = await settings.writePatch({ workspaceCollapsed: { a: true, b: false } })
    const versions = initial.workspaceCollapseVersions
    expect(versions).toEqual({ a: 1, b: 1 })
    await settings.writePatch({ workspaceCollapsed: { a: false }, workspaceCollapseExpectedVersions: { a: 1 } })
    await settings.writePatch({ workspaceCollapsed: { a: true }, workspaceCollapseExpectedVersions: { a: 2 } })
    const before = await readFile(file, "utf8")
    await expect(settings.writePatch({ theme: "dark", workspaceCollapsed: { a: false, b: true }, workspaceCollapseExpectedVersions: { a: 1, b: 1 } })).rejects.toThrow("changed")
    expect(await readFile(file, "utf8")).toBe(before)
    settings.dispose()
    const reloaded = new AppSettingsManager(file)
    try {
      await reloaded.initialize()
      expect(reloaded.getSnapshot().workspaceCollapseVersions).toEqual({ a: 3, b: 1 })
      await reloaded.writePatch({ workspaceCollapsed: { b: true }, workspaceCollapseExpectedVersions: { b: 1 } })
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ workspaceCollapsed: { a: true, b: true }, workspaceCollapseVersions: { a: 3, b: 2 } })
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
    expect(await response.json()).toEqual({ machineName: "Sample computer", workspaceCollapsed: { a: true, b: false }, workspaceCollapseVersions: { a: 0, b: 0 } })
    const post = await fetch(origin + "/api/sidebar-view", { method: "POST", headers: { Cookie: cookie, Origin: origin } })
    expect(post.status).toBe(405); await post.text()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 20_000)

test("external workspace edits advance the guard without changing explicit preferences", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-view-versions-"))
  const file = path.join(root, "settings.json")
  const settings = new AppSettingsManager(file)
  try {
    await writeFile(file, JSON.stringify({ workspaceCollapsed: { a: true } }))
    await settings.initialize()
    expect(settings.getSnapshot().workspaceCollapseVersions).toEqual({ a: 0 })
    const value = JSON.parse(await readFile(file, "utf8"))
    value.workspaceCollapsed.a = false
    await writeFile(file, JSON.stringify(value))
    await settings.reload()
    expect(settings.getSnapshot().workspaceCollapsed).toEqual({ a: false })
    expect(settings.getSnapshot().workspaceCollapseVersions).toEqual({ a: 1 })
    await expect(settings.writePatch({ workspaceCollapsed: { a: true }, workspaceCollapseExpectedVersions: { a: 0 } })).rejects.toThrow("changed")
  } finally { settings.dispose(); await rm(root, { recursive: true, force: true }) }
})
