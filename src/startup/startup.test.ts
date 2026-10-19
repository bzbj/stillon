import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { injectStartupShell, isStartupDocument } from "../../scripts/startup-shell"

const source = readFileSync(new URL("./controller.js", import.meta.url), "utf8")

test("only the application document opts into startup; isolated fixtures and other HTML remain independent", () => {
  expect(isStartupDocument("/app/index.html", "/app/index.html")).toBe(true)
  expect(isStartupDocument("/app/scripts/test-fixtures/remote-auth/index.html", "/app/index.html")).toBe(false)
  expect(isStartupDocument("/app/other/index.html", "/app/index.html")).toBe(false)
  expect(isStartupDocument("C:\\app\\index.html", "C:/app/index.html")).toBe(true)
})

class Target {
  listeners = new Map<string, Array<(event: any) => void>>()
  addEventListener(name: string, callback: (event: any) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], callback])
  }
  dispatch(name: string, event: object = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
}
class Element extends Target {
  hidden = false
  inert = false
  open = false
  nativeModal = false
  focused = false
  textContent = ""
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === "open") this.open = true }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === "open") this.open = false }
  showModal() { this.open = true; this.nativeModal = true }
  close() { this.open = false; this.nativeModal = false; this.dispatch("close") }
  contains(node: unknown) { return node === this }
  focus() { this.focused = true }
}
class Script extends Element {}
class Link extends Element { media = "print"; rel = "stylesheet"; sheet: object | null = null }

function fixture({ style = false, portal = false, reducedMotion = false } = {}) {
  const elements = new Map(["stillon-startup", "root", "stillon-startup-status", "stillon-startup-detail", "stillon-startup-recovery"].map(id => [id, new Element()]))
  const shell = elements.get("stillon-startup")!, root = elements.get("root")!
  shell.open = true; shell.dataset.mode = portal ? "portal" : "host"
  root.inert = true; root.setAttribute("aria-hidden", "true")
  const window = new Target() as Target & { StillOnStartup: { active: boolean; show(): void; hold(): void; fail(): void; reveal(valid?: () => boolean): void } }
  const link = new Link()
  const frames: Array<() => void> = [], timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  runInNewContext(source, {
    window, document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => style ? [link] : [], activeElement: shell },
    location: { pathname: portal ? "/authorize" : "/" },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    matchMedia: () => ({ matches: reducedMotion }), performance: { mark() {} }, HTMLScriptElement: Script, HTMLLinkElement: Link,
  })
  return { window, api: window.StillOnStartup, shell, root, link, elements,
    async paint() {
      for (let i = 0; i < 5; i++) await Promise.resolve()
      for (const frame of frames.splice(0)) frame()
    },
    elapse(ms: number) { for (const [id, timer] of [...timers]) if (timer.ms <= ms) { timers.delete(id); timer.fn() } },
  }
}

test("both HTML entries paint the same public avatar before the independent controller and app", () => {
  const input = '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'
  for (const mode of ["host", "portal"] as const) {
    const output = injectStartupShell(input, mode)
    expect(output).toContain(`data-mode="${mode}"`)
    expect(output).toContain('media="print" data-stillon-styles')
    expect(output).toContain('<div id="root" inert aria-hidden="true">')
    expect(output).toMatch(/<script src="\/assets\/startup-[a-f0-9]{12}\.js"><\/script>/)
    expect(output.indexOf('id="stillon-startup"')).toBeLessThan(output.indexOf('id="root"'))
    expect(output).not.toContain("onload=")
    expect(output).not.toContain("unsafe-inline")
  }
})

test("ready never exposes an unstyled workspace and modal isolation lasts through the exit fade", async () => {
  const f = fixture({ style: true })
  expect(f.shell.nativeModal).toBe(true)
  f.api.reveal()
  await f.paint(); f.elapse(180)
  expect(f.root.inert).toBe(true)
  expect(f.shell.hidden).toBe(false)
  f.link.dispatch("load")
  await f.paint()
  expect(f.link.media).toBe("all")
  expect(f.root.inert).toBe(true)
  f.elapse(180)
  expect(f.root.inert).toBe(false)
  expect(f.root.attributes.has("aria-hidden")).toBe(false)
  expect(f.shell.hidden).toBe(true)
  expect(f.shell.open).toBe(false)
})

test("a superseded session/navigation cannot reveal while waiting for styles or while fading", async () => {
  const f = fixture()
  let valid = true
  f.api.reveal(() => valid)
  valid = false
  await f.paint(); f.elapse(180)
  expect(f.root.inert).toBe(true)
  f.api.reveal()
  await f.paint()
  f.api.hold()
  f.elapse(180)
  expect(f.shell.hidden).toBe(false)
  expect(f.root.inert).toBe(true)
  expect(f.shell.attributes.has("data-leaving")).toBe(false)
  f.api.reveal()
  await f.paint(); f.elapse(180)
  expect(f.shell.hidden).toBe(true)
})

test("failed entry/style loads keep private UI isolated and expose recovery without React", async () => {
  const f = fixture({ style: true })
  f.link.dispatch("error")
  f.api.reveal()
  await f.paint(); f.elapse(8000)
  expect(f.root.inert).toBe(true)
  expect(f.elements.get("stillon-startup-recovery")!.open).toBe(true)
  expect(f.elements.get("stillon-startup-status")!.textContent).toContain("couldn’t open")
  let prevented = false
  f.shell.dispatch("cancel", { preventDefault() { prevented = true } })
  expect(prevented).toBe(true)
  f.shell.close()
  expect(f.shell.open).toBe(true)
})

test("portal can cover OTP verification immediately, then reveal its error/form without a minimum dwell", async () => {
  const f = fixture({ portal: true, reducedMotion: true })
  f.api.reveal()
  await f.paint(); f.elapse(0)
  expect(f.api.active).toBe(false)
  f.api.show()
  expect(f.api.active).toBe(true)
  expect(f.root.inert).toBe(true)
  expect(f.shell.nativeModal).toBe(true)
  f.api.reveal()
  await f.paint(); f.elapse(0)
  expect(f.root.inert).toBe(false)
})

test("slow loading offers recovery and keeps waiting for real ready", () => {
  const f = fixture()
  f.elapse(8000)
  expect(f.api.active).toBe(true)
  expect(f.root.inert).toBe(true)
  expect(f.elements.get("stillon-startup-recovery")!.open).toBe(true)
  expect(f.elements.get("stillon-startup-status")!.textContent).not.toContain("couldn’t")
})

test("an optional favicon/manifest failure cannot strand an otherwise ready workspace", async () => {
  const f = fixture()
  const icon = new Link(); icon.rel = "icon"
  f.window.dispatch("error", { target: icon })
  f.api.reveal()
  await f.paint(); f.elapse(180)
  expect(f.root.inert).toBe(false)
  const brokenEntry = fixture()
  brokenEntry.window.dispatch("error", { target: new Script() })
  brokenEntry.api.reveal()
  await brokenEntry.paint(); brokenEntry.elapse(180)
  expect(brokenEntry.root.inert).toBe(true)
})
