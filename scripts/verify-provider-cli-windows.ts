import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { discoverDeepSeek, deepSeekVersion, spawnDeepSeek } from "../addons/deepseek/src/deepseek-cli"
import { DeepSeekRpc } from "../addons/deepseek/src/deepseek-harness"

// Uses public, separately installed CLIs; never signs in or sends an inference request.
if (!process.argv.includes("--run") || process.platform !== "win32") {
  throw new Error("Run on Windows with --run and the supported public CLIs installed.")
}
const dsh = await discoverDeepSeek()
assert.equal(await deepSeekVersion(dsh, process.env), "0.2.1-rc.5")
const root = path.resolve("test-artifacts/windows-provider-cli", crypto.randomUUID())
const home = path.join(root, "home"), cwd = path.join(root, "workspace 中文 with spaces")
for (const directory of [home, cwd]) await mkdir(directory, { recursive: true })
const env: NodeJS.ProcessEnv = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(STILLON_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|DSH_|DEEPSEEK_|NODE_OPTIONS$|BUN_OPTIONS$)/iu.test(key)) delete env[key]
}
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"),
  LOCALAPPDATA: path.join(home, "AppData/Local"), DSH_HOME: path.join(home, "dsh") })
const rpc = new DeepSeekRpc(spawnDeepSeek(dsh, cwd, env))
try {
  const result = await rpc.request("initialize", { provider: "deepseek-official", model: "deepseek-flash", cwd,
    approvalRequests: true, capabilities: { userQuestions: true } })
  assert.equal(result?.serverInfo?.name, "deepseek-harness-sdk-runtime")
} finally { await rpc.close() }
console.log(`PASS: ${process.platform}/${process.arch}, dsh 0.2.1-rc.5; isolated public CLI initialization and confirmed shutdown.`)
