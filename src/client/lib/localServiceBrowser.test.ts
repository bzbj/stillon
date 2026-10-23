import { describe, expect, test } from "bun:test"
import { localServiceBrowserAddress } from "./localServiceBrowser"

describe("local service browser routing", () => {
  test("opens loopback services only from a loopback visiting origin", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      for (const service of ["http://127.0.0.1:5173/demo?q=1#part", "https://localhost:8443/", "http://[::1]:3000/"]) {
        expect(localServiceBrowserAddress(service, host)).toBe(service)
        for (const remote of ["h-" + "a".repeat(32) + ".stillon.example.com", "192.168.1.2", "localhost.example.com", ""]) {
          expect(localServiceBrowserAddress(service, remote)).toBeNull()
        }
      }
    }
  })
  test("keeps file targets, external sites and invalid addresses out of direct service routing", () => {
    for (const address of ["/api/projects/example/preview/index.html", "https://example.com/", "http://localhost.example.com/", "javascript:alert(1)", "http://user:password@localhost:3000", "http://localhost:0/"]) {
      expect(localServiceBrowserAddress(address, "localhost")).toBeNull()
    }
  })
})
