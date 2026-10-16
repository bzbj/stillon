import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createConnector } from "./connector"
import { newDeviceKeys, randomToken } from "./crypto"

const old = "https://previous-connect.example.invalid", origin = "https://connect.example.invalid"
const custom = "https://self-hosted.example.invalid"

async function fixture(run: (root: string, dataDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-package-origin-"))
  const dataDir = path.join(root, "data")
  try {
    await mkdir(path.join(root, "runtime"), { recursive: true })
    await mkdir(path.join(dataDir, "connect"), { recursive: true })
    await writeFile(path.join(root, "runtime/connect.json"), JSON.stringify({ origin, migrateFromOrigins: [old] }))
    await run(root, dataDir)
  } finally { await rm(root, { recursive: true, force: true }) }
}
function options(root: string, dataDir: string, explicit?: string) {
  return { runtimeRoot: root, dataDir, origin: explicit, targetOrigin: "http://127.0.0.1:9", localSecret: randomToken(), name: () => "Fixture computer" }
}
function pausedState(serviceOrigin: string) {
  return { version: 1, origin: serviceOrigin, keys: newDeviceKeys(), name: "Fixture computer", paused: true, pendingUnbind: false,
    binding: { hostId: "fixture-host", name: "Fixture computer", email: "person@example.invalid", epoch: 3, gatewayPublicKey: "fixture-key", url: `https://h-fixture-host.${new URL(serviceOrigin).host}/` } }
}

test("a fresh package profile is configured for email binding without environment or saved state", async () => {
  await fixture(async (root, dataDir) => {
    const connector = await createConnector(options(root, dataDir))
    try { expect(connector.status()).toMatchObject({ configured: true, origin, state: "unbound" }) }
    finally { await connector.stop() }
  })
})

for (const [deviceOrigin, savedOrigin, explicit] of [[old, old, undefined], [old, origin, undefined], [origin, old, undefined], [old, old, old], [old, old, origin]]) {
  test(`approved migration converges across restarts: device=${deviceOrigin}, saved=${savedOrigin}, explicit=${explicit ?? "none"}`, async () => {
    await fixture(async (root, dataDir) => {
      const deviceFile = path.join(dataDir, "connect/device.json"), serviceFile = path.join(dataDir, "connect/service.json")
      const before = pausedState(deviceOrigin!)
      await writeFile(deviceFile, JSON.stringify(before))
      await writeFile(serviceFile, JSON.stringify({ origin: savedOrigin, retainedSetting: true }))
      for (let attempt = 0; attempt < 2; attempt++) {
        const connector = await createConnector(options(root, dataDir, explicit))
        try {
          expect(connector.status()).toMatchObject({ origin, state: "paused", hostId: before.binding.hostId })
          const after = JSON.parse(await readFile(deviceFile, "utf8"))
          expect(after).toEqual({ ...before, origin, binding: { ...before.binding, url: "https://h-fixture-host.connect.example.invalid/" } })
          expect(JSON.parse(await readFile(serviceFile, "utf8"))).toEqual({ origin, retainedSetting: true })
          if (process.platform !== "win32") expect((await stat(serviceFile)).mode & 0o777).toBe(0o600)
        } finally { await connector.stop() }
      }
    })
  })
}

test("unrelated self-hosted state and explicit service overrides are retained", async () => {
  for (const [deviceOrigin, explicit] of [[custom, undefined], [old, custom]]) {
    await fixture(async (root, dataDir) => {
      const file = path.join(dataDir, "connect/device.json"), before = pausedState(deviceOrigin!)
      await writeFile(file, JSON.stringify(before))
      await writeFile(path.join(dataDir, "connect/service.json"), JSON.stringify({ origin: deviceOrigin }))
      const connector = await createConnector(options(root, dataDir, explicit))
      try {
        expect(connector.status().origin).toBe(deviceOrigin!)
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual(before)
        expect(JSON.parse(await readFile(path.join(dataDir, "connect/service.json"), "utf8"))).toEqual({ origin: deviceOrigin })
      } finally { await connector.stop() }
    })
  }
})

test("invalid package policy cannot move an existing bound device", async () => {
  await fixture(async (root, dataDir) => {
    const before = pausedState(old), file = path.join(dataDir, "connect/device.json")
    await writeFile(file, JSON.stringify(before))
    await writeFile(path.join(root, "runtime/connect.json"), JSON.stringify({ origin: "http://insecure.example.invalid", migrateFromOrigins: [old] }))
    const connector = await createConnector(options(root, dataDir))
    try {
      expect(connector.status().origin).toBe(old)
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(before)
    } finally { await connector.stop() }
  })
})
