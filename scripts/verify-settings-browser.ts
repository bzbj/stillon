import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Page } from "playwright"
import { createConnectFixture, eventually } from "./connect-fixture"
import { startStillOnServer } from "../src/server/server"

// Synthetic CLIs, accounts and temporary data only; no real authentication or installers.
// Bun caches homedir at process startup. Spawn with the isolated home already set,
// before importing/initializing any application services in that process.
if (!process.argv.includes("--isolated-settings-child")) {
  const home = await mkdtemp(path.join(os.tmpdir(), "stillon-settings-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STILLON_UPDATE_") && !name.startsWith("STILLON_CONNECT_") && name !== "STILLON_RUNTIME_PROFILE"))
  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    const executable = chromium.executablePath()
    const marker = executable.lastIndexOf(path.sep + "chromium-")
    assert(marker >= 0, "Cannot locate the installed Playwright browser cache")
    env.PLAYWRIGHT_BROWSERS_PATH = executable.slice(0, marker)
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), STILLON_SETTINGS_TEST_ROOT: home })
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2), "--isolated-settings-child"], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  let code = 1
  try { code = await child.exited } finally { await rm(home, { recursive: true, force: true }) }
  process.exit(code)
}
const root = process.env.STILLON_SETTINGS_TEST_ROOT!
const output = path.resolve("test-artifacts/settings", process.argv.includes("--local-only") ? "local" : "connect")
await mkdir(output, { recursive: true })
for (const name of Object.keys(process.env)) if (name.startsWith("STILLON_UPDATE_") || name.startsWith("STILLON_CONNECT_") || name === "STILLON_RUNTIME_PROFILE") delete process.env[name]
Object.assign(process.env, { HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, ".codex"), CLAUDE_CONFIG_DIR: path.join(root, ".claude"), STILLON_MACHINE_NAME: "Test computer", STILLON_AGENT_PATH: path.join(root, "bin") })
const bin = path.join(root, "bin")
await mkdir(bin, { recursive: true })
const clis: Record<string, string> = {}
for (const provider of ["codex", "claude"]) {
  const file = path.join(bin, provider)
  await writeFile(file, `#!${process.execPath}\nconst fs=require('node:fs');const flag=${JSON.stringify(path.join(root, provider + "-state"))};let state='ready';try{state=fs.readFileSync(flag,'utf8')}catch{};if(state==='error')process.exit(2);if(process.argv.includes('--version')){console.log('1.2.3');process.exit(0)};if(process.argv.includes('status')){console.log(state==='ready'?'Signed in':'Sign-in required');process.exit(state==='ready'?0:1)};process.exit(0)\n`, { mode: 0o700 })
  await chmod(file, 0o700)
  clis[provider] = file
}
process.env.CODEX_EXECUTABLE = clis.codex
process.env.CLAUDE_EXECUTABLE = clis.claude
const localOnly = process.argv.includes("--local-only")
const managed = localOnly ? null : await createConnectFixture(1)
const server = managed?.hosts[0] ?? await startStillOnServer({ port: 0, strictPort: true, dataDir: path.join(root, "data"), discoveryHome: root })
const origin = `http://127.0.0.1:${server.port}`
const entries: { name: string; origin: string; cookie?: string }[] = [{ name: "local", origin }]
const cookies = (r: Response) => r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const checks: string[] = []
let stage = "startup"
const progress = setInterval(() => console.log("Settings acceptance: " + stage), 10_000)
progress.unref()
const activePages: Page[] = []
try {
  if (managed) {
    const enroll = await eventually(async () => { const r = await fetch(origin + "/api/connect-local/enroll", { method: "POST", headers: { Origin: origin } }); return r.ok ? r.json() : null }, v => Boolean(v?.id))
    const central = (route: string, body: unknown, cookie = "") => fetch(managed.origin + "/api/connect/" + route, { method: "POST", headers: { Origin: managed.origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const intent = { purpose: "enroll", id: enroll.id }, email = "settings@example.com"
    const pending = await central("request-code", { email, intent })
    const verified = await central("verify-code", { email, intent, code: managed.messages.at(-1)!.code, remember: true }, cookies(pending))
    assert.equal(verified.status, 200)
    const status = await eventually(async () => (await fetch(origin + "/api/connect-local/status")).json(), v => v.state === "online")
    const remote = new URL(status.url).origin
    const login = await fetch(managed.origin + "/_connect/login", { redirect: "manual", headers: { Host: new URL(remote).host } })
    const flow = new URL(login.headers.get("location")!).searchParams.get("flow")
    const authorized = await central("authorize", { flow }, cookies(verified))
    const callback = (await authorized.json()).redirect
    const callbackUrl = new URL(callback)
    const entered = await fetch(managed.origin + callbackUrl.pathname + callbackUrl.search, { redirect: "manual", headers: { Host: new URL(remote).host, Cookie: cookies(login) } })
    assert.equal(entered.status, 303)
    entries.push({ name: "connect", origin: remote, cookie: cookies(entered) })
    checks.push("Authenticated gateway, real tunnel, adapter and proposed host")
  }
  const executablePath = process.argv.find(arg => arg.startsWith("--browser-executable="))?.slice("--browser-executable=".length)
  browser = await chromium.launch({ headless: true, executablePath })
  const pages: Page[] = []
  for (const entry of entries) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.setDefaultTimeout(45_000)
    if (entry.cookie) await context.addCookies(entry.cookie.split("; ").map(c => { const i = c.indexOf("="); return { name: c.slice(0, i), value: c.slice(i + 1), url: entry.origin } }))
    await context.route("https://api.github.com/repos/bzbj/stillon/releases", route => route.fulfill({ json: [
      { id: 2, name: "Latest fixture release", tag_name: "v9.0.0", html_url: "https://github.com/bzbj/stillon/releases/tag/v9.0.0", published_at: "2026-01-02T00:00:00Z", body: "Latest fixture notes", prerelease: false, draft: false },
      { id: 1, name: "Older fixture release", tag_name: "v0.1.0", html_url: "https://github.com/bzbj/stillon/releases/tag/v0.1.0", published_at: "2026-01-01T00:00:00Z", body: "Older fixture notes", prerelease: false, draft: false },
    ] }))
    const page = await context.newPage()
    page.on("pageerror", error => console.error("Browser error: " + error.message))
    pages.push(page); activePages.push(page)
  }
  async function settings(p: Page, entry: number, section: string) {
    stage = entries[entry]!.name + ": " + section
    await p.goto(entries[entry]!.origin + "/settings/" + section)
    await p.waitForURL("**/settings/" + section)
    await p.locator("button:visible").filter({ hasText: /^Providers$/ }).first().waitFor()
    if (section === "sound") await p.getByRole("region", { name: "Sound settings", exact: true }).waitFor()
  }
  async function editName(p: Page, value: string) {
    const input = p.locator("#machine-name")
    await input.waitFor()
    await input.click()
    await input.press("ControlOrMeta+A")
    await input.pressSequentially(value)
    await p.getByText("Unsaved changes", { exact: true }).waitFor()
  }
  for (let i = 0; i < entries.length; i++) {
    const p = pages[i]!
    stage = entries[i]!.name + ": settings entry"
    await p.goto(entries[i]!.origin + "/settings")
    await p.getByRole("link", { name: "Open Providers", exact: true }).waitFor()
    await p.getByLabel("Step 3 complete", { exact: true }).waitFor()
    assert.equal(await p.locator("#onboarding-machine-name").count(), 0)
    await p.getByRole("link", { name: "Open Providers", exact: true }).click()
    await p.getByText("Codex CLI is signed in.", { exact: true }).waitFor()
    assert.equal(await p.getByRole("button", { name: "Use Codex", exact: true }).count(), 0)
    assert.equal(await p.getByText("CLI updates", { exact: true }).count(), 0)
    assert.equal(await p.getByRole("button", { name: "Check for updates", exact: true }).count(), 1)
    await p.getByRole("button", { name: "Claude Code", exact: true }).click()
    await p.getByText("Claude Code CLI is signed in.", { exact: true }).waitFor()
    assert.equal(await p.getByRole("button", { name: "Use Claude Code", exact: true }).count(), 0)
    const modelId = p.getByPlaceholder("Model ID supported by your CLI and account", { exact: true })
    await modelId.pressSequentially("draft-model-id")
    await p.getByRole("button", { name: "Codex", exact: true }).click()
    await p.getByRole("button", { name: "Claude Code", exact: true }).click()
    assert.equal(await modelId.inputValue(), "draft-model-id", "Switching provider tabs must preserve unfinished model configuration")
    await p.screenshot({ path: path.join(output, entries[i]!.name + "-providers.png"), fullPage: true })
    await settings(p, i, "welcome")
    await p.getByRole("button", { name: "Finish setup", exact: true }).click()
    await p.waitForURL("**/settings/providers")
    await p.getByRole("button", { name: "Appearance", exact: true }).click()
    await p.getByRole("group", { name: "Theme palette", exact: true }).waitFor()
    assert.equal(await p.getByRole("button", { name: "Get started", exact: true }).count(), 0)
    assert.equal(await p.getByRole("slider", { name: "Sidebar width", exact: true }).count(), 0)
    assert.equal(await p.getByRole("group", { name: "Conversation width", exact: true }).count(), 0)
    assert.equal(await p.getByRole("group", { name: "Theme palette", exact: true }).count(), 1)
    const theme = p.locator("section").filter({ has: p.getByRole("heading", { name: "Theme", exact: true }) })
    assert.equal(await theme.getByRole("button", { name: "Choose image", exact: true }).count(), 1)
    assert.equal(await p.getByText("Notification Sounds", { exact: true }).count(), 0)
    await p.getByRole("button", { name: i === 0 ? "Forest" : "Ocean", exact: true }).click()
    await p.getByRole("button", { name: "Apply appearance", exact: true }).click()
    await p.getByText("Appearance applied.", { exact: true }).waitFor()
    await p.screenshot({ path: path.join(output, entries[i]!.name + "-appearance.png"), fullPage: true })
    await p.getByRole("button", { name: "Sound", exact: true }).click()
    await p.waitForURL("**/settings/sound")
    const sound = p.getByRole("region", { name: "Sound settings", exact: true })
    await sound.waitFor()
    assert.equal(await sound.getByText("Notification Sounds", { exact: true }).count(), 1)
    assert.equal(await sound.getByText("Sound Effect", { exact: true }).count(), 1)
    assert.equal(await sound.locator(".border-t").count(), 0)
    assert.equal(await p.getByRole("group", { name: "Theme palette", exact: true }).count(), 0)
    if (i > 0) assert.match(await sound.getByRole("combobox").nth(0).innerText(), /Never/)
    await sound.getByRole("combobox").nth(0).click()
    await p.getByRole("option", { name: i === 0 ? "Never" : "When Unfocused", exact: true }).click()
    await eventually(async () => (await Bun.file(path.join(server.store.dataDir, "settings.json")).json()).chatSoundPreference, value => value === (i === 0 ? "never" : "unfocused"))
    await sound.getByRole("combobox").nth(1).click()
    await p.getByRole("option", { name: i === 0 ? "Pop" : "Frog", exact: true }).click()
    await eventually(async () => (await Bun.file(path.join(server.store.dataDir, "settings.json")).json()).chatSoundId, value => value === (i === 0 ? "pop" : "frog"))
    await p.reload()
    await p.getByRole("region", { name: "Sound settings", exact: true }).waitFor()
    assert.match(await p.getByRole("combobox").nth(0).innerText(), i === 0 ? /Never/ : /When Unfocused/)
    await p.goto(entries[i]!.origin + "/settings")
    await p.waitForURL("**/settings/sound")
    await p.screenshot({ path: path.join(output, entries[i]!.name + "-sound.png"), fullPage: true })

    await settings(p, i, "about")
    await editName(p, "Fixture " + entries[i]!.name)
    await p.getByRole("button", { name: "Save name", exact: true }).click()
    await p.getByText(/^Saved as /).waitFor()
    assert.equal(await p.getByText("Managed updates", { exact: true }).count(), 0)
    await p.getByRole("button", { name: "Check for Updates", exact: true }).click()
    await p.getByRole("button", { name: "Copy update prompt", exact: true }).waitFor()
    const prompt = await p.getByRole("textbox", { name: "Update prompt", exact: true }).inputValue()
    assert(prompt.length <= 800 && prompt.includes("local/Connect connections"))
    assert(prompt.includes("start about 5 seconds later") && prompt.includes("end this agent turn without waiting"))
    assert(prompt.includes("native idle check every 5 seconds for up to 12 hours"))
    assert(prompt.includes("verify its managed instance identity") && prompt.includes("force-terminate that process before backing up"))
    assert(prompt.includes("If idle wait times out, leave StillOn running"))
    assert.equal(await p.locator("details[open]").count(), 0)
    await p.getByText("Previous releases", { exact: true }).click()
    await p.getByText("Older fixture notes", { exact: true }).waitFor()
    await p.reload()
    await p.locator("#machine-name").waitFor()
    assert.equal(await p.locator("#machine-name").inputValue(), "Fixture " + entries[i]!.name)
    stage = entries[i]!.name + ": settings entry"
    await p.goto(entries[i]!.origin + "/settings")
    await p.locator("#machine-name").waitFor()
    assert.deepEqual((await p.locator("aside button").allTextContents()).filter(name => name !== "Sign out"), ["Network", "Providers", "Usage", "Skills & Prompts", "Appearance", "Sound", "Remote access", "About"])
    await settings(p, i, "keybindings")
    assert.equal(await p.getByRole("button", { name: "Keyboard Shortcuts", exact: true }).getAttribute("aria-pressed"), "true")
    await settings(p, i, "quick-commands")
    assert.equal(await p.getByRole("button", { name: "Preset Prompts", exact: true }).getAttribute("aria-pressed"), "true")
    await p.screenshot({ path: path.join(output, entries[i]!.name + ".png"), fullPage: true })
    checks.push(entries[i]!.name + ": original controls, navigation, onboarding, provider tabs, upgrade prompt, collapsed notes and saves")
  }
  if (pages.length > 1) {
    await settings(pages[0]!, 0, "about")
    assert.equal(await pages[0]!.locator("#machine-name").inputValue(), "Fixture connect")
    await editName(pages[0]!, "Cross-entry name")
    await pages[0]!.getByRole("button", { name: "Save name", exact: true }).click()
    await pages[0]!.getByText(/^Saved as /).waitFor()
    await settings(pages[1]!, 1, "about")
    assert.equal(await pages[1]!.locator("#machine-name").inputValue(), "Cross-entry name")
    await settings(pages[0]!, 0, "sound")
    assert.match(await pages[0]!.getByRole("combobox").nth(0).innerText(), /When Unfocused/)
    assert.match(await pages[0]!.getByRole("combobox").nth(1).innerText(), /Frog/)
    await pages[0]!.getByRole("combobox").nth(0).click()
    await pages[0]!.getByRole("option", { name: "Always", exact: true }).click()
    await eventually(async () => (await Bun.file(path.join(server.store.dataDir, "settings.json")).json()).chatSoundPreference, value => value === "always")
    await settings(pages[1]!, 1, "sound")
    assert.match(await pages[1]!.getByRole("combobox").nth(0).innerText(), /Always/)
    checks.push("Sound settings: local/remote saves, reciprocal reloads and returning destination")
    checks.push("Remote save to local reload; local save to remote reload")
  }
  const settingsFile = path.join(server.store.dataDir, "settings.json")
  await rename(settingsFile, settingsFile + ".backup")
  await mkdir(settingsFile)
  try {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]!
      await settings(p, i, "about")
      await editName(p, "Uncommitted draft " + entries[i]!.name)
      await p.getByRole("button", { name: "Save name", exact: true }).click()
      await p.locator("#machine-name-error").waitFor()
      assert.equal(await p.locator("#machine-name").inputValue(), "Uncommitted draft " + entries[i]!.name)
    }
    checks.push("Failed local/remote saves preserve confirmed settings and editable drafts")
  } finally { await rm(settingsFile, { recursive: true }); await rename(settingsFile + ".backup", settingsFile) }
  for (const provider of ["codex", "claude"]) {
    const p = pages[0]!, label = provider === "codex" ? "Codex" : "Claude Code"
    for (const state of ["signed-out", "error", "missing"]) {
      await writeFile(path.join(root, provider + "-state"), state)
      if (state === "missing") await rename(clis[provider]!, clis[provider]! + ".disabled")
      try {
        await settings(p, 0, "providers")
        if (provider === "claude") await p.getByRole("button", { name: "Claude Code", exact: true }).click()
        if (state === "signed-out") {
          if (["darwin", "win32"].includes(process.platform)) await p.getByRole("button", { name: "Open terminal to sign in", exact: true }).waitFor()
          else await p.getByText("Open StillOn locally on", { exact: false }).waitFor()
        }
        if (state === "error") await p.getByText("The CLI could not be checked.", { exact: false }).waitFor()
        if (state === "missing") {
          if (["darwin", "win32"].includes(process.platform)) await p.getByRole("button", { name: `Install ${label} CLI`, exact: true }).waitFor()
          else await p.getByText(`Could not find ${label} CLI`, { exact: false }).waitFor()
        }
      } finally { if (state === "missing") await rename(clis[provider]! + ".disabled", clis[provider]!) }
    }
    await writeFile(path.join(root, provider + "-state"), "ready")
    checks.push(label + ": signed-out, CLI failure, missing installation and recovery actions retained")
  }
  await pages[0]!.setViewportSize({ width: 390, height: 844 })
  await settings(pages[0]!, 0, "appearance")
  assert.equal(await pages[0]!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await pages[0]!.screenshot({ path: path.join(output, "mobile.png"), fullPage: true })
  await writeFile(path.join(output, "results.json"), JSON.stringify({ localOnly, checks }, null, 2))
  console.log(JSON.stringify({ localOnly, checks }, null, 2))
} catch (error) {
  console.error("Failed at " + stage)
  for (let i = 0; i < activePages.length; i++) {
    await activePages[i]!.screenshot({ path: path.join(output, `failure-${i}.png`), fullPage: true }).catch(() => {})
    console.error((await activePages[i]!.locator("body").innerText().catch(() => "")).slice(-3000))
  }
  throw error
} finally {
  clearInterval(progress)
  await browser?.close()
  if (managed) await managed.stop(); else await server.stop()
  await rm(root, { recursive: true, force: true })
}
