import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { normalizeAppearance } from "../src/shared/appearance"
import { AppSettingsManager, readAppSettingsSnapshot } from "../src/server/app-settings"
import { exportSkin, importSkin } from "../src/server/appearance-assets"

/** Small real PNG + portable skin used by disposable update/uninstall acceptance. */
export const APPEARANCE_FIXTURE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwat/8HwAExwJsQI6LhQAAAABJRU5ErkJggg==", "base64")
const preferences = normalizeAppearance({ palette: "forest", accent: "#287954", font: "system", density: "compact", cornerRadius: 12, sidebarWidth: 335, chatWidth: "wide", surface: "soft", backgroundOpacity: 0.24 })
export async function seedAppearanceFixture(dataRoot: string) {
  const dataDir = path.join(dataRoot, "data")
  await mkdir(dataDir, { recursive: true })
  const { backgroundAsset, skinName, ...appearance } = preferences
  const imported = await importSkin(dataDir, Buffer.from(JSON.stringify({ format: "stillon-skin", themeApi: 1, uiApi: 1, name: "Personal acceptance", appearance,
    background: { mimeType: "image/png", base64: APPEARANCE_FIXTURE_PNG.toString("base64") } })))
  const settingsPath = path.join(dataDir, "settings.json")
  const manager = new AppSettingsManager(settingsPath)
  await manager.initialize()
  try { await manager.writePatch({ browserSettingsMigrated: true, machineName: "Appearance acceptance", theme: "dark", appearance: imported.appearance }) }
  finally { manager.dispose() }
  return { settingsPath, assetPath: path.join(dataDir, "customizations/appearance/assets", imported.appearance.backgroundAsset!), skinPath: path.join(dataDir, "customizations/appearance/skins", imported.id), appearance: imported.appearance }
}
export async function assertAppearanceFixture(dataRoot: string) {
  const dataDir = path.join(dataRoot, "data")
  const saved = (await readAppSettingsSnapshot(path.join(dataDir, "settings.json"))).appearance
  const { backgroundAsset, skinName, ...appearance } = saved
  const { backgroundAsset: ignoredAsset, skinName: ignoredName, ...expected } = preferences
  if (JSON.stringify(appearance) !== JSON.stringify(expected) || skinName !== "Personal acceptance" || !backgroundAsset) throw new Error("Personal appearance settings were not preserved")
  const exported = await exportSkin(dataDir, saved)
  if (exported.background?.base64 !== APPEARANCE_FIXTURE_PNG.toString("base64")) throw new Error("Personal background image was not preserved")
  const bytes = await readFile(path.join(dataDir, "customizations/appearance/assets", backgroundAsset))
  if (!bytes.equals(APPEARANCE_FIXTURE_PNG)) throw new Error("Personal background bytes changed")
}
