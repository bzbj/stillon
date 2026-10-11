import { describe, expect, test } from "bun:test"
import { APPEARANCE_PALETTES, appearanceVariables, contrastRatio, defaultAppearance, mergeAppearance, normalizeAppearance, paletteSwatch, readableForeground } from "./appearance"

describe("appearance API", () => {
  test("old installations and unsupported schemas use built-in defaults", () => {
    for (const value of [undefined, null, [], "custom", { schemaVersion: 2, palette: "forest" }]) expect(normalizeAppearance(value)).toEqual(defaultAppearance())
  })
  test("normalizes bounded values and excludes CSS, paths and executable values", () => {
    expect(normalizeAppearance({ accent: "url(javascript:x)", lightBackground: "red; display:none", font: "evil", fontSize: 99, cornerRadius: -10, sidebarWidth: Infinity, backgroundAsset: "../../secret.png", backgroundOpacity: 99 })).toMatchObject({
      accent: null, lightBackground: null, font: "body", fontSize: 18, cornerRadius: 4, sidebarWidth: 275, backgroundAsset: null, backgroundOpacity: 0.4,
    })
    expect(normalizeAppearance({ fontSize: NaN, sidebarWidth: null }).sidebarWidth).toBeNull()
  })
  test("partial changes preserve the rest of the skin", () => {
    const current = normalizeAppearance({ palette: "ocean", accent: "#12ABCD", density: "compact", backgroundAsset: `${"a".repeat(64)}.png` })
    expect(mergeAppearance(current, { sidebarWidth: 333 })).toEqual({ ...current, sidebarWidth: 333 })
  })
  test("all palette modes and custom accent colors select readable foregrounds", () => {
    for (const palette of APPEARANCE_PALETTES) {
      for (const color of paletteSwatch(palette)) expect(contrastRatio(color, readableForeground(color))).toBeGreaterThanOrEqual(4.5)
      for (const mode of ["light", "dark"] as const) {
        const variables = appearanceVariables({ ...defaultAppearance(), palette }, mode)
        expect(variables["--stillon-wallpaper"]).toBe("none")
        expect(variables["--stillon-row-height"]).toBe("38px")
      }
    }
    for (const color of ["#777777", "#888888", "#f4eeff", "#000000", "#cc6677", "#ffffff"]) expect(contrastRatio(color, readableForeground(color))).toBeGreaterThanOrEqual(4.5)
  })
  test("default appearance preserves built-in semantic colors; local assets have a fixed route", () => {
    expect(appearanceVariables(defaultAppearance(), "light")["--background"]).toBeUndefined()
    const a = normalizeAppearance({ palette: "forest", density: "compact", font: "mono", chatWidth: "full", backgroundAsset: `${"b".repeat(64)}.webp` })
    const variables = appearanceVariables(a, "dark")
    expect(variables["--stillon-wallpaper"]).toBe(`url('/api/appearance/assets/${a.backgroundAsset}')`)
    expect(variables["--stillon-chat-width"]).toBe("100%")
    expect(variables["--stillon-row-height"]).toBe("30px")
    expect(variables["--stillon-font"]).toContain("Consolas")
  })
})
