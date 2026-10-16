import { expect, test } from "bun:test"
import { desktopConnectConfig, migrateConnectState, parseConnectRuntimeConfig } from "./config"

const old = "https://previous-connect.example.invalid"
const origin = "https://connect.example.invalid"

test("managed releases reject absent, insecure, example and malformed origins", () => {
  for (const value of [undefined, "", "http://connect.product.dev", "https://connect.example.invalid", "https://example.com", "https://localhost", "https://127.0.0.1", "https://connect.product.dev/", "https://user:pass@connect.product.dev"]) {
    expect(() => desktopConnectConfig({ STILLON_REQUIRE_CONNECT: "1", STILLON_CONNECT_ORIGIN: value })).toThrow()
  }
  expect(desktopConnectConfig({ STILLON_REQUIRE_CONNECT: "1", STILLON_CONNECT_ORIGIN: "https://connect.product.dev", STILLON_CONNECT_MIGRATE_FROM_ORIGINS: JSON.stringify([old]) })).toEqual({ origin: "https://connect.product.dev", migrateFromOrigins: [old] })
})

test("local/self-hosted builds are explicit and migration metadata must be valid", () => {
  expect(desktopConnectConfig({})).toBeNull()
  expect(desktopConnectConfig({ STILLON_CONNECT_ORIGIN: origin })).toEqual({ origin })
  for (const migration of ["not-json", "null", '"all"', '["http://localhost"]', JSON.stringify([origin])]) {
    expect(() => desktopConnectConfig({ STILLON_CONNECT_ORIGIN: origin, STILLON_CONNECT_MIGRATE_FROM_ORIGINS: migration })).toThrow()
  }
  expect(() => desktopConnectConfig({ STILLON_CONNECT_MIGRATE_FROM_ORIGINS: JSON.stringify([old]) })).toThrow()
  expect(parseConnectRuntimeConfig({ origin, migrateFromOrigins: [old, old] })).toEqual({ origin, migrateFromOrigins: [old] })
})

test("domain migration retains identity, revocation and enrollment state and rewrites only matching URLs", () => {
  const state = { origin: old, keys: { privateKey: "fixture-private", publicKey: "fixture-public" }, paused: true, pendingUnbind: true, pendingPause: true,
    enrollment: { id: "fixture-enrollment", expiresAt: 123, verificationUrl: `${old}/bind?ticket=fixture#continue` },
    binding: { hostId: "fixture-host", email: "person@example.invalid", epoch: 7, gatewayPublicKey: "fixture-gateway", url: "https://h-fixture-host.previous-connect.example.invalid/" } }
  const moved = migrateConnectState(state, origin)
  expect(moved).toEqual({ ...state, origin,
    enrollment: { ...state.enrollment, verificationUrl: `${origin}/bind?ticket=fixture#continue` },
    binding: { ...state.binding, url: "https://h-fixture-host.connect.example.invalid/" } })
  expect(state.origin).toBe(old)
  const custom = { ...state, enrollment: { ...state.enrollment, verificationUrl: "https://unrelated.example.invalid/bind" }, binding: { ...state.binding, url: "https://unrelated.example.invalid/" } }
  const retained = migrateConnectState(custom, origin)
  expect(retained.enrollment).toEqual(custom.enrollment)
  expect(retained.binding).toEqual(custom.binding)
})
