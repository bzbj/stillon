/** Public, data-only appearance API. Never interpret skin values as CSS or JS. */
export const APPEARANCE_API = 1
export const APPEARANCE_PALETTES = ["default", "ocean", "forest", "violet", "sand"] as const
export type AppearancePalette = typeof APPEARANCE_PALETTES[number]
export interface AppearanceSettings {
  schemaVersion: 1
  palette: AppearancePalette
  accent: string | null
  lightBackground: string | null
  darkBackground: string | null
  font: "body" | "system" | "mono"
  fontSize: number
  cornerRadius: number
  density: "comfortable" | "compact"
  surface: "solid" | "soft" | "glass"
  sidebarWidth: number | null
  chatWidth: "comfortable" | "wide" | "full"
  backgroundAsset: string | null
  backgroundOpacity: number
  skinName: string | null
}

export function defaultAppearance(): AppearanceSettings {
  return {
    schemaVersion: 1, palette: "default", accent: null, lightBackground: null, darkBackground: null,
    font: "body", fontSize: 14, cornerRadius: 8, density: "comfortable", surface: "solid",
    sidebarWidth: null, chatWidth: "comfortable", backgroundAsset: null, backgroundOpacity: 0.12, skinName: null,
  }
}

export const BACKGROUND_ASSET_PATTERN = /^[a-f0-9]{64}\.(png|jpg|webp)$/
export function isAppearanceColor(value: unknown): value is string {
  return typeof value === "string" && /^#[a-f\d]{6}$/i.test(value)
}
function bounded(value: unknown, fallback: number, min: number, max: number, step = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) / step) * step
}

/** Shared normalization keeps server, optimistic updates and renderer identical. */
export function normalizeAppearance(value: unknown): AppearanceSettings {
  const d = defaultAppearance()
  if (!value || typeof value !== "object" || Array.isArray(value)) return d
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== undefined && v.schemaVersion !== APPEARANCE_API) return d
  return {
    schemaVersion: 1,
    palette: APPEARANCE_PALETTES.includes(v.palette as AppearancePalette) ? v.palette as AppearancePalette : d.palette,
    accent: isAppearanceColor(v.accent) ? v.accent.toLowerCase() : null,
    lightBackground: isAppearanceColor(v.lightBackground) ? v.lightBackground.toLowerCase() : null,
    darkBackground: isAppearanceColor(v.darkBackground) ? v.darkBackground.toLowerCase() : null,
    font: v.font === "system" || v.font === "mono" ? v.font : "body",
    fontSize: bounded(v.fontSize, d.fontSize, 13, 18),
    cornerRadius: bounded(v.cornerRadius, d.cornerRadius, 4, 20),
    density: v.density === "compact" ? "compact" : "comfortable",
    surface: v.surface === "soft" || v.surface === "glass" ? v.surface : "solid",
    sidebarWidth: typeof v.sidebarWidth === "number" ? bounded(v.sidebarWidth, 275, 220, 520) : null,
    chatWidth: v.chatWidth === "wide" || v.chatWidth === "full" ? v.chatWidth : "comfortable",
    backgroundAsset: typeof v.backgroundAsset === "string" && BACKGROUND_ASSET_PATTERN.test(v.backgroundAsset) ? v.backgroundAsset : null,
    backgroundOpacity: bounded(v.backgroundOpacity, d.backgroundOpacity, 0, 0.4, 0.01),
    skinName: typeof v.skinName === "string" && v.skinName.trim() ? v.skinName.trim().slice(0, 80) : null,
  }
}

export function mergeAppearance(current: AppearanceSettings | undefined, patch?: Partial<AppearanceSettings>) {
  return normalizeAppearance({ ...normalizeAppearance(current), ...patch })
}

export interface SkinPackage {
  format: "stillon-skin"
  themeApi: 1
  uiApi: 1
  name: string
  appearance: Omit<AppearanceSettings, "backgroundAsset" | "skinName">
  background?: { mimeType: "image/png" | "image/jpeg" | "image/webp"; base64: string }
}

const paletteColors: Record<AppearancePalette, [string, string, string]> = {
  default: ["#24334d", "#ffffff", "#202123"],
  ocean: ["#0879b5", "#f1f7fa", "#111d29"],
  forest: ["#287954", "#f3f7f2", "#14231d"],
  violet: ["#7550b2", "#f7f4fc", "#201a2d"],
  sand: ["#976321", "#faf6ee", "#28221b"],
}
export const PALETTE_LABELS: Record<AppearancePalette, string> = {
  default: "StillOn", ocean: "Ocean", forest: "Forest", violet: "Violet", sand: "Sand",
}
export function paletteSwatch(palette: AppearancePalette) { return paletteColors[palette] }
function rgb(hex: string) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) }
function mix(a: string, b: string, amount: number) {
  const first = rgb(a), second = rgb(b)
  return `#${first.map((n, i) => Math.round(n * (1 - amount) + second[i]! * amount).toString(16).padStart(2, "0")).join("")}`
}
function luminance(hex: string) {
  const channels = rgb(hex).map((n) => { const v = n / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}
export function contrastRatio(a: string, b: string) {
  const first = luminance(a), second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
export function readableForeground(background: string) {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#ffffff") ? "#000000" : "#ffffff"
}
export function hexToHsl(hex: string) {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min, light = (max + min) / 2
  let hue = 0, saturation = 0
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * light - 1))
    hue = max === r ? ((g - b) / delta + (g < b ? 6 : 0)) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    hue *= 60
  }
  return `${hue.toFixed(2)} ${(saturation * 100).toFixed(2)}% ${(light * 100).toFixed(2)}%`
}

/** Map primitives onto the existing semantic tokens and stable component aliases. */
export function appearanceVariables(raw: AppearanceSettings, mode: "light" | "dark"): Record<string, string> {
  const a = normalizeAppearance(raw)
  const [accent, light, dark] = paletteColors[a.palette]
  const background = (mode === "dark" ? a.darkBackground : a.lightBackground) ?? (mode === "dark" ? dark : light)
  const foreground = readableForeground(background)
  let surface = mix(background, foreground, mode === "dark" ? 0.04 : 0.025)
  if (contrastRatio(surface, foreground) < 4.5) surface = background
  let mutedForeground = foreground
  for (let amount = 0.7; amount <= 1; amount += 0.05) {
    const candidate = mix(background, foreground, amount)
    if (Math.min(contrastRatio(background, candidate), contrastRatio(surface, candidate)) >= 4.5) { mutedForeground = candidate; break }
  }
  const primary = a.accent ?? (a.palette === "default" && mode === "dark" ? "#fafafa" : accent)
  const variables: Record<string, string> = {
    "--radius": `${a.cornerRadius}px`,
    "--stillon-font": a.font === "system" ? "system-ui, -apple-system, 'Segoe UI', sans-serif" : a.font === "mono" ? "ui-monospace, SFMono-Regular, Consolas, monospace" : "'Body', sans-serif",
    "--stillon-font-size": `${a.fontSize}px`,
    "--stillon-chat-width": a.chatWidth === "full" ? "100%" : a.chatWidth === "wide" ? "1200px" : "800px",
    "--stillon-composer-width": a.chatWidth === "full" ? "100%" : a.chatWidth === "wide" ? "1200px" : "840px",
    "--stillon-row-height": a.density === "compact" ? "30px" : "38px",
    "--stillon-row-padding": a.density === "compact" ? "4px" : "8px",
    "--stillon-wallpaper": a.backgroundAsset ? `url('/api/appearance/assets/${a.backgroundAsset}')` : "none",
    "--stillon-wallpaper-opacity": String(a.backgroundOpacity),
    "--stillon-surface": a.surface === "glass" ? `hsl(${hexToHsl(surface)} / 0.88)` : `hsl(${hexToHsl(a.surface === "soft" ? surface : background)})`,
    "--stillon-sidebar-surface": a.backgroundAsset && a.backgroundOpacity > 0 ? "transparent" : "var(--stillon-surface)",
    "--stillon-surface-shadow": a.surface === "solid" ? "none" : "0 6px 24px rgb(0 0 0 / 0.06)",
  }
  if (a.sidebarWidth !== null) variables["--stillon-sidebar-width"] = `${a.sidebarWidth}px`
  // Preserve the exact built-in colors for the default palette unless edited.
  if (a.palette !== "default" || a.accent || a.lightBackground || a.darkBackground) {
    const colors = {
      background, foreground, card: surface, "card-foreground": foreground, popover: surface, "popover-foreground": foreground,
      primary, "primary-foreground": readableForeground(primary), secondary: surface, "secondary-foreground": foreground,
      muted: surface, "muted-foreground": mutedForeground, accent: mix(background, primary, 0.1),
      "accent-foreground": foreground, border: mix(background, foreground, 0.18), input: mix(background, foreground, 0.15),
      ring: primary, "muted-icon": mix(background, foreground, 0.55),
    }
    for (const [key, value] of Object.entries(colors)) variables[`--${key}`] = hexToHsl(value)
  }
  return variables
}
