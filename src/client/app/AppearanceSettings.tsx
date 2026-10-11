import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Check, Download, ImagePlus, RotateCcw, Upload } from "lucide-react"
import { APPEARANCE_PALETTES, PALETTE_LABELS, appearanceVariables, defaultAppearance, normalizeAppearance, paletteSwatch, type AppearanceSettings } from "../../shared/appearance"
import type { AppSettingsPatch, AppSettingsSnapshot, AppThemePreference } from "../../shared/types"
import { Button } from "../components/ui/button"
import { useAppearance } from "../hooks/useAppearance"
import { cn } from "../lib/utils"

const fieldClass = "h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
function Field({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-4 py-4">
    <div><div className="text-sm font-medium">{title}</div>{description ? <p className="mt-1 max-w-md text-xs text-muted-foreground">{description}</p> : null}</div>
    {children}
  </div>
}
function Choices<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return <div role="group" aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/30 p-1">
    {options.map(([id, title]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)} className={cn("min-h-9 rounded-lg px-3 text-sm", value === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{title}</button>)}
  </div>
}
function ColorField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void }) {
  return <label className="flex items-center gap-3 rounded-xl border border-border p-3">
    <input type="color" aria-label={label} value={value ?? fallback} onChange={(event) => onChange(event.target.value)} className="h-9 w-10 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" />
    <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{label}</span><span className="font-mono text-xs uppercase">{value ?? fallback}</span></span>
    <button type="button" aria-label={`Reset ${label}`} disabled={!value} onClick={() => onChange(null)} className="rounded p-1 text-muted-foreground disabled:opacity-30"><RotateCcw className="size-3.5" /></button>
  </label>
}

export function AppearanceSettingsPanel({ settings, onSave }: {
  settings: AppSettingsSnapshot | null
  onSave: (patch: AppSettingsPatch) => Promise<AppSettingsSnapshot>
}) {
  const { preview, safeMode, setPreview } = useAppearance()
  const confirmed = useMemo(() => normalizeAppearance(settings?.appearance), [settings?.appearance])
  const [draft, setDraft] = useState(confirmed)
  const [mode, setMode] = useState<AppThemePreference>(settings?.theme ?? "system")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const backgroundInput = useRef<HTMLInputElement>(null)
  const skinInput = useRef<HTMLInputElement>(null)
  const confirmedKey = JSON.stringify([confirmed, settings?.theme])
  const dirty = JSON.stringify([draft, mode]) !== confirmedKey
  const previewMode = mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode
  const swatch = paletteSwatch(draft.palette)
  const variables = appearanceVariables({ ...draft, lightBackground: draft.lightBackground ?? swatch[1], darkBackground: draft.darkBackground ?? swatch[2] }, previewMode)

  useEffect(() => {
    setDraft(confirmed)
    setMode(settings?.theme ?? "system")
    setPreview(null)
    // A repeated server snapshot or unrelated setting must not discard this draft.
  }, [confirmedKey])
  useEffect(() => {
    if (preview) setPreview({ appearance: draft, theme: mode })
  }, [draft, mode])

  function patch(value: Partial<AppearanceSettings>) { setDraft((current) => normalizeAppearance({ ...current, ...value })); setNotice(null); setError(null) }
  function cancel() { setDraft(confirmed); setMode(settings?.theme ?? "system"); setPreview(null); setError(null); setNotice(null) }
  async function apply() {
    setBusy(true); setError(null); setNotice(null)
    try {
      await onSave({ appearance: draft, theme: mode })
      setPreview(null)
      setNotice("Appearance applied. Your skin and layout are saved on this machine.")
    } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : "Unable to save appearance. Your previous settings are kept.") }
    finally { setBusy(false) }
  }
  async function upload(file: File | undefined, kind: "background" | "skin") {
    if (!file) return
    const limit = (kind === "skin" ? 3 : 2) * 1024 * 1024
    if (file.size > limit) { setError(`${kind === "skin" ? "Skin files" : "Images"} must be ${kind === "skin" ? 3 : 2} MB or smaller.`); return }
    setBusy(true); setError(null); setNotice(null)
    try {
      const response = await fetch(kind === "skin" ? "/api/appearance/skins/import" : "/api/appearance/background", {
        method: "POST", body: file, headers: { "Content-Type": kind === "skin" ? "application/json" : file.type || "application/octet-stream" },
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Unable to import this file.")
      if (kind === "skin") setDraft(normalizeAppearance(result.appearance))
      else patch({ backgroundAsset: result.asset })
      setNotice(`${kind === "skin" ? "Skin" : "Background"} ready to preview. Apply to keep it.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to import this file.") }
    finally { setBusy(false) }
  }
  async function exportApplied() {
    setBusy(true); setError(null)
    try {
      const response = await fetch("/api/appearance/skin/export")
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Unable to export this skin.") }
      const objectUrl = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = objectUrl; anchor.download = "stillon-skin.json"; anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      setNotice("Applied skin exported, including its background image.")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to export this skin.") }
    finally { setBusy(false) }
  }

  return <div data-stillon-part="appearance-settings" className="space-y-6">
    {safeMode ? <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
      <p className="font-medium">Safe mode · personal styling is paused</p>
      <p className="mt-1 text-muted-foreground">Change your settings or restore defaults, then apply.</p>
      <a className="mt-2 inline-block underline" href="/settings/appearance">Return to your saved appearance</a>
    </div> : null}
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4"><div><h2 className="text-sm font-semibold">Your workspace</h2><p className="mt-1 text-xs text-muted-foreground">A preview of your theme and layout</p></div><span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "Applied"}</span></div>
      <div aria-label="Skin preview" style={{ ...variables, background: "hsl(var(--background))", color: "hsl(var(--foreground))", fontFamily: "var(--stillon-font)", position: "relative" } as CSSProperties}>
        {draft.backgroundAsset && !safeMode ? <img src={`/api/appearance/assets/${draft.backgroundAsset}`} alt="" onError={() => setError("The background could not be displayed. Choose another image or remove it.")} className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={{ opacity: draft.backgroundOpacity }} /> : null}
        <div className="relative flex min-h-44 gap-3 p-4 sm:min-h-52">
          <div className="flex w-[28%] shrink-0 flex-col gap-2 border border-border p-2" style={{ background: "var(--stillon-surface)", borderRadius: "calc(var(--radius) + 4px)", boxShadow: "var(--stillon-surface-shadow)" }}><span className="text-xs font-semibold">StillOn</span><div className="mt-2 h-2 w-3/4 rounded bg-muted-foreground/20" /><div className="h-2 w-full rounded bg-muted-foreground/15" /><div className="h-2 w-2/3 rounded bg-muted-foreground/15" /><div className="mt-auto rounded bg-accent px-2 py-1 text-[10px] text-accent-foreground">My project</div></div>
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-1 sm:p-3"><div><div className="text-sm font-semibold">Room for your ideas</div><p className="mt-1 text-xs text-muted-foreground">A workspace that feels like yours.</p></div><div className="flex gap-2"><span className="rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground">Ready</span><span className="rounded-full border border-border px-3 py-1 text-xs">Local</span></div><div className="mt-auto border border-border bg-background/90 p-3 text-xs text-muted-foreground" style={{ borderRadius: "calc(var(--radius) + 4px)" }}>What would you like to work on?</div></div>
        </div>
      </div>
    </div>

    <fieldset disabled={busy} className="space-y-6 disabled:opacity-70">
      <section className="rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold">Theme</h2>
        <Field title="Color mode"><Choices label="Color mode" value={mode} options={[["light", "Light"], ["dark", "Dark"], ["system", "System"]]} onChange={setMode} /></Field>
        <div role="group" aria-label="Theme palette" className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 132px), 1fr))" }}>
          {APPEARANCE_PALETTES.map((id) => { const [accent, background] = paletteSwatch(id); return <button type="button" key={id} aria-pressed={draft.palette === id} onClick={() => patch({ palette: id, accent: null, lightBackground: null, darkBackground: null, skinName: null })} className={cn("relative rounded-xl border p-3 text-left", draft.palette === id ? "border-primary ring-1 ring-primary" : "border-border hover:bg-muted/30")}>
            <div className="mb-3 flex gap-1.5"><span className="size-5 rounded-full border border-black/10" style={{ background: accent }} /><span className="size-5 rounded-full border border-black/10" style={{ background }} /><span className="size-5 rounded-full border border-black/10" style={{ background: paletteSwatch(id)[2] }} /></div><span className="text-xs font-medium">{PALETTE_LABELS[id]}</span>{draft.palette === id ? <Check className="absolute bottom-3 right-2 size-3" /> : null}
          </button> })}
        </div>
        <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          <ColorField label="Accent color" value={draft.accent} fallback={swatch[0]} onChange={(accent) => patch({ accent })} />
          <ColorField label="Light background" value={draft.lightBackground} fallback={swatch[1]} onChange={(lightBackground) => patch({ lightBackground })} />
          <ColorField label="Dark background" value={draft.darkBackground} fallback={swatch[2]} onChange={(darkBackground) => patch({ darkBackground })} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Text colors adjust to keep your chosen colors readable.</p>
      </section>

      <section className="divide-y divide-border rounded-2xl border border-border px-5">
        <Field title="Typeface"><select aria-label="Typeface" className={fieldClass} value={draft.font} onChange={(event) => patch({ font: event.target.value as AppearanceSettings["font"] })}><option value="body">StillOn</option><option value="system">System</option><option value="mono">Monospace</option></select></Field>
        <Field title="Text size"><label className="flex items-center gap-3"><input aria-label="Text size" type="range" min={13} max={18} value={draft.fontSize} onChange={(event) => patch({ fontSize: Number(event.target.value) })} /><span className="w-9 text-right text-xs tabular-nums">{draft.fontSize}px</span></label></Field>
        <Field title="Corners"><label className="flex items-center gap-3"><input aria-label="Corners" type="range" min={4} max={20} value={draft.cornerRadius} onChange={(event) => patch({ cornerRadius: Number(event.target.value) })} /><span className="w-9 text-right text-xs tabular-nums">{draft.cornerRadius}px</span></label></Field>
        <Field title="Density" description="Spacing in project and conversation lists."><Choices label="Density" value={draft.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={(density) => patch({ density })} /></Field>
        <Field title="Panels"><Choices label="Panel style" value={draft.surface} options={[["solid", "Solid"], ["soft", "Soft"], ["glass", "Glass"]]} onChange={(surface) => patch({ surface })} /></Field>
        <Field title="Sidebar width" description="Saved on this machine. The sidebar fits the available window space."><label className="flex items-center gap-3"><input aria-label="Sidebar width" type="range" min={220} max={520} step={5} value={draft.sidebarWidth ?? 275} onChange={(event) => patch({ sidebarWidth: Number(event.target.value) })} /><span className="w-10 text-right text-xs tabular-nums">{draft.sidebarWidth ?? 275}px</span></label></Field>
        <Field title="Conversation width"><Choices label="Conversation width" value={draft.chatWidth} options={[["comfortable", "Focused"], ["wide", "Wide"], ["full", "Full"]]} onChange={(chatWidth) => patch({ chatWidth })} /></Field>
      </section>

      <section className="rounded-2xl border border-border p-5">
        <Field title="Background image" description="PNG, JPEG or WebP · up to 2 MB"><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => backgroundInput.current?.click()}><ImagePlus className="mr-2 size-4" />Choose image</Button>{draft.backgroundAsset ? <Button size="sm" variant="ghost" onClick={() => patch({ backgroundAsset: null })}>Remove</Button> : null}</div></Field>
        <input ref={backgroundInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload background image" className="hidden" onChange={(event) => { void upload(event.target.files?.[0], "background"); event.target.value = "" }} />
        {draft.backgroundAsset ? <Field title="Background strength"><label className="flex items-center gap-3"><input aria-label="Background strength" type="range" min={0} max={40} value={Math.round(draft.backgroundOpacity * 100)} onChange={(event) => patch({ backgroundOpacity: Number(event.target.value) / 100 })} /><span className="w-9 text-right text-xs tabular-nums">{Math.round(draft.backgroundOpacity * 100)}%</span></label></Field> : null}
      </section>

      <section className="rounded-2xl border border-border p-5">
        <Field title="Your skin" description="Keep a portable copy with your colors, layout and background image."><input aria-label="Skin name" placeholder="My StillOn skin" maxLength={80} value={draft.skinName ?? ""} className={cn(fieldClass, "w-full sm:w-52")} onChange={(event) => { setDraft((current) => ({ ...current, skinName: event.target.value || null })); setNotice(null) }} /></Field>
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => skinInput.current?.click()}><Upload className="mr-2 size-4" />Import skin</Button><Button variant="outline" size="sm" onClick={() => void exportApplied()}><Download className="mr-2 size-4" />Export applied skin</Button></div>
        <input ref={skinInput} type="file" accept=".json,application/json" aria-label="Import skin file" className="hidden" onChange={(event) => { void upload(event.target.files?.[0], "skin"); event.target.value = "" }} />
        <p className="mt-3 text-xs text-muted-foreground">Your personal files are kept when StillOn updates. Imported skins are ready to preview before you apply.</p>
      </section>
    </fieldset>

    {error ? <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
    {notice ? <div role="status" className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">{notice}</div> : null}
    <div className="sticky bottom-0 z-30 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-background/95 p-3 shadow-sm backdrop-blur">
      <Button aria-label="Restore default appearance" variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft({ ...defaultAppearance(), sidebarWidth: 275 }); setMode("system"); setError(null); setNotice("Defaults ready. Apply to restore them.") }}><RotateCcw className="mr-2 size-4" />Restore defaults</Button>
      <div className="flex flex-wrap gap-2"><Button aria-label="Cancel appearance changes" variant="ghost" size="sm" disabled={busy || !dirty && !preview} onClick={cancel}>Cancel</Button><Button aria-label={preview ? "End workspace preview" : "Preview in workspace"} variant="outline" size="sm" disabled={busy || safeMode} onClick={() => setPreview(preview ? null : { appearance: draft, theme: mode })}>{preview ? "End preview" : "Preview in workspace"}</Button><Button aria-label="Apply appearance" size="sm" disabled={busy || !dirty || !settings} onClick={() => void apply()}>{busy ? "Working…" : "Apply appearance"}</Button></div>
    </div>
    <p className="text-xs text-muted-foreground">Need to recover your view? <a className="underline" href="/settings/appearance?safe-mode=1">Open safe mode</a>.</p>
  </div>
}
