import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { APP_VERSION } from "../shared/branding"
import { startStillOnServer } from "./server"

test("upgrade prompts report the connected server and its fallback port over WebSocket", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stillon-upgrade-prompt-"))
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
  let server: Awaited<ReturnType<typeof startStillOnServer>> | undefined
  let socket: WebSocket | undefined
  try {
    server = await startStillOnServer({ dataDir, host: "127.0.0.1", port: occupied.port!, openBrowser: false })
    expect(server.port).not.toBe(occupied.port)
    const connected = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    socket = connected
    const response = await new Promise<{ type: string; result: { prompt: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Upgrade prompt request timed out")), 5_000)
      connected.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("WebSocket failed"))
      })
      connected.addEventListener("open", () => connected.send(JSON.stringify({
        v: 1,
        type: "command",
        id: "upgrade-template",
        command: { type: "settings.generateSourceUpgradePrompt", targetTag: "v1.2.3" },
      })))
      connected.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== "upgrade-template") return
        clearTimeout(timer)
        resolve(message)
      })
    })
    expect(response.type).toBe("ack")
    const line = response.result.prompt.split("\n").find((value) => value.includes('{"currentVersion":'))!
    expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({
      currentVersion: APP_VERSION,
      platform: process.platform,
      runtimeDirectory: path.resolve(import.meta.dir, "..", ".."),
      dataDirectory: path.resolve(dataDir),
      host: "127.0.0.1",
      port: server.port,
    })
    expect(response.result.prompt).toContain("升级到 v1.2.3")
  } finally {
    socket?.close()
    await server?.stop()
    await occupied.stop(true)
    await rm(dataDir, { recursive: true, force: true })
  }
}, 10_000)
