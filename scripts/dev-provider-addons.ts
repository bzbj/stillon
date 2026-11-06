import path from "node:path"
import { homedir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { startStillOnServer } from "../src/server/server"
import { AppSettingsManager } from "../src/server/app-settings"
import { discoverDeepSeek } from "../addons/deepseek/src/deepseek-cli"
import { buildBundledIntegrations } from "./build-integrations"

// Separate preview; never modifies the installed service or its managed metadata.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_")) delete process.env[key]
}
const root = path.resolve(process.env.STILLON_ADDON_PREVIEW_ROOT ?? "test-artifacts/provider-addons-preview")
const port = Number(process.env.STILLON_ADDON_PREVIEW_PORT ?? 3218)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port.")
if (!process.argv.includes("--isolated-child")) {
  await buildBundledIntegrations()
  const isolatedHome = path.join(root, "home")
  await mkdir(isolatedHome, { recursive: true })
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, ".codex"), CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
    DSH_HOME: process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
  }
  for (const key of Object.keys(environment)) if (/^(OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/u.test(key)) delete environment[key]
  try { environment.DSH_EXECUTABLE = await discoverDeepSeek(process.env) } catch { /* CLI absence remains visible in setup. */ }
  const child = Bun.spawn([process.execPath, import.meta.path, "--isolated-child"], { env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(await child.exited)
}
await writeFile(path.join(root, "runtime.pid"), String(process.pid))
const workspace = path.join(root, "workspace"), dataDir = path.join(root, "data")
await mkdir(workspace, { recursive: true })
process.env.STILLON_MACHINE_NAME = "Add-on Test"
const settings = new AppSettingsManager(path.join(dataDir, "settings.json"))
await settings.initialize()
await settings.writePatch({ defaultProvider: "codex", machineName: "Add-on Test" }); settings.dispose()
const app = await startStillOnServer({ port, host: "127.0.0.1", strictPort: true, openBrowser: false,
  dataDir, discoveryHome: path.join(root, "empty-discovery") })
await app.store.openProject(workspace, "Add-on test workspace")
console.log(`Add-on preview ready: http://127.0.0.1:${app.port}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void app.stop().then(() => process.exit(0)) })
