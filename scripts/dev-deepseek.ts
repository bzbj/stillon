import path from "node:path"
import { homedir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { startStillOnServer } from "../src/server/server"
import { AppSettingsManager } from "../src/server/app-settings"
import { discoverDeepSeek } from "../addons/deepseek/src/deepseek-cli"

// Isolated local preview. No installed service, runtime metadata or user chat data is changed.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("STILLON_UPDATE_") || key.startsWith("STILLON_CONNECT_")) delete process.env[key]
}
const root = path.resolve("test-artifacts/deepseek-preview")
if (!process.argv.includes("--isolated-child")) {
  const isolatedHome = path.join(root, "home")
  await mkdir(isolatedHome, { recursive: true })
  const environment = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, ".codex"), CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
    DSH_HOME: process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
    DSH_EXECUTABLE: await discoverDeepSeek(process.env),
  }
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete (environment as NodeJS.ProcessEnv)[key]
  // Bun caches the home directory at process start, so isolation requires a child.
  const child = Bun.spawn([process.execPath, import.meta.path, "--isolated-child"], { env: environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(await child.exited)
}
await writeFile(path.join(root, "runtime.pid"), String(process.pid))
const workspace = path.join(root, "workspace")
const dataDir = path.join(root, "data")
await mkdir(workspace, { recursive: true })
process.env.STILLON_MACHINE_NAME = "DeepSeek Test"
const settings = new AppSettingsManager(path.join(dataDir, "settings.json"))
await settings.initialize()
await settings.writePatch({ defaultProvider: "deepseek", machineName: "DeepSeek Test" })
settings.dispose()
const app = await startStillOnServer({ port: 3217, host: "127.0.0.1", strictPort: true, openBrowser: false,
  dataDir, discoveryHome: path.join(root, "empty-discovery") })
const project = await app.store.openProject(workspace, "DeepSeek test workspace")
if (!Array.from(app.store.state.chatsById.values()).some(chat => chat.projectId === project.id)) {
  const chat = await app.store.createChat(project.id)
  await app.store.renameChat(chat.id, "DeepSeek API test")
  await app.store.setChatTurnPreferences(chat.id, { provider: "deepseek", model: "deepseek-flash", modelOptions: { reasoningEffort: "off" }, permissionMode: "request" })
}
console.log(`DeepSeek preview ready: http://127.0.0.1:${app.port}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void app.stop().then(() => process.exit(0)) })
