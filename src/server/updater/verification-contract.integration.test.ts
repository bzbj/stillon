import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startStillOnServer } from "../server"
import { readUpdateSettingsSnapshot } from "./settings-snapshot"

test("paused application keeps WebSocket/mutations closed while local settings evidence remains readable", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "stillon-paused-verification-"))
  const dataDir = path.join(dataRoot, "data")
  await mkdir(dataDir)
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ machineName: "Preserved upgrade fixture" }))
  const values = { STILLON_UPDATE_INSTANCE: "verification-fixture", STILLON_UPDATE_SECRET: "fixture-private-key", STILLON_UPDATE_VERIFYING: "1" }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  try {
    Object.assign(process.env, values)
    server = await startStillOnServer({ dataDir, discoveryHome: dataRoot, port: 0, strictPort: true, openBrowser: false,
      codexModelDiscovery: { discover: async () => { throw new Error("Disabled in verification fixture") } } })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (!server) await rm(dataRoot, { recursive: true, force: true })
  }
  try {
    const origin = `http://127.0.0.1:${server!.port}`
    const bytes = await readFile(path.join(dataDir, "settings.json"), "utf8")
    expect((await fetch(origin + "/health")).status).toBe(200)
    expect((await fetch(origin + "/ws", { headers: { Origin: origin } })).status).toBe(503)
    expect((await fetch(origin + "/api/connect-local/enroll", { method: "POST", headers: { Origin: origin } })).status).toBe(503)
    const snapshot = await readUpdateSettingsSnapshot({ dataRoot })
    expect(snapshot.present).toBe(true)
    expect(snapshot.settings.machineName).toBe("Preserved upgrade fixture")
    expect(await readFile(path.join(dataDir, "settings.json"), "utf8")).toBe(bytes)
    // Reading settings must not accidentally release the application gate.
    expect((await fetch(origin + "/ws", { headers: { Origin: origin } })).status).toBe(503)
    expect((await fetch(origin + "/_stillon/update/resume", { method: "POST" })).status).toBe(403)
    expect((await fetch(origin + "/_stillon/update/resume", { method: "POST", headers: { Authorization: "Bearer fixture-private-key" } })).status).toBe(200)
    expect((await fetch(origin + "/ws", { headers: { Origin: origin } })).status).not.toBe(503)
  } finally {
    await server!.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
}, 30_000)
