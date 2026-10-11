import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultAppearance } from "../shared/appearance"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import { exportSkin, handleAppearanceRequest, importSkin, MAX_BACKGROUND_BYTES, saveBackground, validateBackground } from "./appearance-assets"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwat/8HwAExwJsQI6LhQAAAABJRU5ErkJggg==", "base64")
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), "stillon-appearance-")); dirs.push(dir); return dir }
function skin(overrides: Record<string, unknown> = {}) {
  const { backgroundAsset, skinName, ...appearance } = defaultAppearance()
  return Buffer.from(JSON.stringify({ format: "stillon-skin", themeApi: 1, uiApi: 1, name: "Personal", appearance, ...overrides }))
}

describe("personal appearance files", () => {
  test("validates content and pixel limits rather than filenames", async () => {
    expect(await validateBackground(png)).toMatchObject({ extension: "png", width: 1, height: 1 })
    await expect(validateBackground(Buffer.from('<svg onload="alert(1)"/>'))).rejects.toThrow("PNG, JPEG or WebP")
    await expect(validateBackground(Buffer.alloc(MAX_BACKGROUND_BYTES + 1))).rejects.toThrow("2 MB")
    const large = Buffer.from(png); large.writeUInt32BE(4097, 16)
    await expect(validateBackground(large)).rejects.toThrow("4096")
    await expect(validateBackground(png.subarray(0, 40))).rejects.toThrow("Invalid PNG")
  })
  test("imports without applying, exports portably and reloads persisted settings", async () => {
    const first = await directory(), second = await directory()
    const manager = new AppSettingsManager(path.join(first, "settings.json"))
    await manager.initialize()
    try {
      const original = manager.getSnapshot()
      const imported = await importSkin(first, skin({ appearance: { palette: "forest", density: "compact", sidebarWidth: 335, font: "system" }, background: { mimeType: "image/png", base64: png.toString("base64") } }))
      expect(manager.getSnapshot()).toEqual(original)
      await manager.writePatch({ appearance: imported.appearance })
      await manager.writePatch({ appearance: { chatWidth: "wide" } })
      const reloaded = await readAppSettingsSnapshot(manager.filePath)
      expect(reloaded.appearance).toMatchObject({ palette: "forest", density: "compact", sidebarWidth: 335, chatWidth: "wide", skinName: "Personal", backgroundAsset: imported.appearance.backgroundAsset })
      const exported = await exportSkin(first, reloaded.appearance)
      expect(exported.background?.base64).toBe(png.toString("base64"))
      expect(JSON.stringify(exported)).not.toContain(first)
      const copied = await importSkin(second, Buffer.from(JSON.stringify(exported)))
      expect(copied.appearance).toEqual(reloaded.appearance)
      const assets = await readdir(path.join(first, "customizations/appearance/assets"))
      expect(assets).toEqual([imported.appearance.backgroundAsset!])
    } finally { manager.dispose() }
  })
  test("unsupported skins are retained and inactive; unsafe settings are rejected", async () => {
    const dir = await directory()
    await expect(importSkin(dir, skin({ uiApi: 2 }))).rejects.toThrow("file was kept")
    expect((await readdir(path.join(dir, "customizations/appearance/skins"))).length).toBe(1)
    for (const appearance of [{ accent: "url(https://example.com)" }, { css: "body{display:none}" }, { fontSize: 999 }, { backgroundAsset: "../../secret" }]) {
      await expect(importSkin(dir, skin({ appearance }))).rejects.toThrow()
    }
    await expect(importSkin(dir, skin({ javascript: "alert(1)" }))).rejects.toThrow("unsupported fields")
    await expect(importSkin(dir, skin({ background: { mimeType: "image/jpeg", base64: png.toString("base64") } }))).rejects.toThrow("does not match")
  })
  test("asset publication deduplicates concurrently and refuses symlinks and corruption", async () => {
    const dir = await directory()
    const results = await Promise.all(Array.from({ length: 6 }, () => saveBackground(dir, png)))
    expect(new Set(results.map((result) => result.asset)).size).toBe(1)
    const assets = path.join(dir, "customizations/appearance/assets")
    const asset = results[0]!.asset
    expect(await readdir(assets)).toEqual([asset])
    await writeFile(path.join(assets, asset), "corrupt")
    await expect(saveBackground(dir, png)).rejects.toThrow("damaged")
    const other = await directory(), outside = await directory()
    await mkdir(path.join(other, "customizations/appearance"), { recursive: true })
    await symlink(outside, path.join(other, "customizations/appearance/assets"), process.platform === "win32" ? "junction" : "dir")
    await expect(saveBackground(other, png)).rejects.toThrow("local directory")
    expect(await readdir(outside)).toEqual([])
  })
  test("HTTP upload uses bounded streams, rejects cross-origin mutation and serves fixed asset routes", async () => {
    const dir = await directory()
    const options = { dataDir: dir, getAppearance: defaultAppearance, validateOrigin: (req: Request) => req.headers.get("origin") !== "https://evil.example" }
    const url = new URL("http://localhost/api/appearance/background")
    const forbidden = await handleAppearanceRequest(new Request(url, { method: "POST", body: png, headers: { origin: "https://evil.example" } }), url, options)
    expect(forbidden?.status).toBe(403)
    const oversized = new Request(url, { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(MAX_BACKGROUND_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close() } }), duplex: "half" } as RequestInit)
    expect((await handleAppearanceRequest(oversized, url, options))?.status).toBe(413)
    const response = await handleAppearanceRequest(new Request(url, { method: "POST", body: png }), url, options)
    expect(response?.status).toBe(200)
    const { asset } = await response!.json()
    const assetUrl = new URL(`/api/appearance/assets/${asset}`, url)
    const served = await handleAppearanceRequest(new Request(assetUrl), assetUrl, options)
    expect(served?.headers.get("Content-Type")).toBe("image/png")
    expect(served?.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(Buffer.from(await served!.arrayBuffer())).toEqual(png)
    expect((await handleAppearanceRequest(new Request(url), url, options))?.status).toBe(405)
    expect(await readFile(path.join(dir, "customizations/appearance/assets", asset))).toEqual(png)
  })
})
