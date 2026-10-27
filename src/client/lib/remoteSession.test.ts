import { expect, test } from "bun:test"
import { isConnectBrowser } from "./remoteSession"

test("owned and invited workspace origins both use remote receipts and private browser storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  try {
    for (const prefix of ["h", "w"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname: `${prefix}-${"a".repeat(32)}.connect.example.com` } } })
      expect(isConnectBrowser()).toBe(true)
    }
    for (const hostname of ["localhost", "127.0.0.1", "connect.example.com", "w-invalid.connect.example.com"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname } } })
      expect(isConnectBrowser()).toBe(false)
    }
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window") }
})
