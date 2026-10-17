import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager } from "./app-settings"

test("workspace fold choices survive disk reload and concurrent per-workspace writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-folds-"))
  const file = path.join(root, "settings.json")
  const manager = new AppSettingsManager(file)
  try {
    await manager.initialize()
    await manager.writePatch({ workspaceCollapsed: { "workspace-a": true } })
    await Promise.all([
      manager.writePatch({ workspaceCollapsed: { "workspace-b": false } }),
      manager.writePatch({ workspaceCollapsed: { "workspace-c": true } }),
    ])
    expect(JSON.parse(await readFile(file, "utf8")).workspaceCollapsed).toEqual({ "workspace-a": true, "workspace-b": false, "workspace-c": true })
    manager.dispose()
    const reloaded = new AppSettingsManager(file)
    try {
      await reloaded.initialize()
      await reloaded.writePatch({ theme: "dark" })
      expect(JSON.parse(await readFile(file, "utf8")).workspaceCollapsed).toEqual({ "workspace-a": true, "workspace-b": false, "workspace-c": true })
    } finally { reloaded.dispose() }
  } finally { manager.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("rejected fold changes preserve the saved file and later valid writes still work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stillon-fold-failure-"))
  const file = path.join(root, "settings.json")
  const manager = new AppSettingsManager(file)
  try {
    await manager.initialize()
    await manager.writePatch({ workspaceCollapsed: { a: true, b: false } })
    const before = await readFile(file, "utf8")
    await expect(manager.writePatch({ workspaceCollapsed: { a: false, b: "closed" } } as never)).rejects.toThrow("true or false")
    expect(await readFile(file, "utf8")).toBe(before)
    expect(manager.getSnapshot().workspaceCollapsed).toEqual({ a: true, b: false })
    const snapshot = manager.getSnapshot()
    snapshot.workspaceCollapsed!.a = false
    expect(manager.getSnapshot().workspaceCollapsed!.a).toBe(true)
    await manager.writePatch({ workspaceCollapsed: { a: false } })
    expect(JSON.parse(await readFile(file, "utf8")).workspaceCollapsed).toEqual({ a: false, b: false })
  } finally { manager.dispose(); await rm(root, { recursive: true, force: true }) }
})
