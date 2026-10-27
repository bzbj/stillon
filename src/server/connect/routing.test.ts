import { expect, test } from "bun:test"
import { bypassesProxy, createConnectRouting, networkFailure, transportEnvironment } from "./routing"

test("Auto starts direct, shares a credential-safe proxy route and backs off failures", () => {
  let now = 0
  const policy = createConnectRouting("https://connect.example.com", { https_proxy: "http://user:secret@proxy.example.com:8080" }, () => now)
  expect(policy.proxy).toBe("")
  expect(policy.fail("api", "DNS_FAILED")).toBe(true)
  expect(policy.route).toBe("proxy")
  expect(policy.proxy).toContain("user:secret")
  expect(JSON.stringify(policy.diagnostics())).not.toMatch(/user|secret|proxy.example/)
  expect(policy.retryDelay).toBe(5_000)
  expect(policy.fail("tunnel", "TUNNEL_TIMEOUT", 0)).toBe(false) // obsolete attempt
  expect(policy.route).toBe("proxy")
  expect(policy.probeDue()).toBe(false)
  now = 300_000
  expect(policy.probeDue()).toBe(true)
  policy.probeResult(false)
  expect(policy.route).toBe("proxy")
  now += 300_000
  policy.probeResult(true)
  expect(policy.route).toBe("direct")
  policy.fail("tunnel", "TUNNEL_TIMEOUT")
  expect(policy.route).toBe("proxy")
  expect(policy.retryDelay).toBe(10_000)
  policy.online()
  policy.fail("api", "CONNECTION_FAILED")
  expect(policy.route).toBe("direct")
  expect(policy.retryDelay).toBe(5_000)
})

test("lowercase values win; HTTPS, HTTP and ALL proxy precedence is consistent", () => {
  for (const [environment, expected] of [
    [{ HTTPS_PROXY: "http://upper:80", https_proxy: "http://lower:80", http_proxy: "http://http:80" }, "lower"],
    [{ HTTP_PROXY: "http://http:80", ALL_PROXY: "http://all:80" }, "http"],
    [{ all_proxy: "http://all:80" }, "all"],
  ] as const) {
    const routing = createConnectRouting("https://connect.example.com", environment)
    routing.fail("api", "TIMEOUT")
    expect(new URL(routing.proxy).hostname).toBe(expected)
  }
})

test("bypass rules apply to the entire API/tunnel policy, including ports and IPv6", () => {
  for (const [url, entries, expected] of [
    ["https://connect.example.com", "example.com", true],
    ["https://connect.example.com", ".example.com:443", true],
    ["https://connect.example.com:8443", "*.example.com:443", false],
    ["https://badexample.com", "example.com", false],
    ["http://[::1]:8080", "[::1]:8080", true],
    ["http://[::1]:8080", "[::1]:8081", false],
    ["https://anything.invalid", "*", true],
  ] as const) expect(bypassesProxy(new URL(url), entries)).toBe(expected)
  const routing = createConnectRouting("https://connect.example.com", { HTTP_PROXY: "http://proxy:80", NO_PROXY: "tunnel.example.com" })
  routing.setTunnel(new URL("https://tunnel.example.com"))
  expect(routing.fail("tunnel", "TUNNEL_TIMEOUT")).toBe(false)
  expect(routing.route).toBe("direct")
  expect(routing.diagnostics().proxyAvailable).toBe(false)
})

test("trust, auth, application and unsupported-proxy failures never trigger fallback", () => {
  const routing = createConnectRouting("https://connect.example.com", { HTTP_PROXY: "http://proxy:80" })
  for (const code of ["TLS_FAILED", "INVALID_PROOF", "ACCESS_PAUSED", "SERVICE_UNAVAILABLE", "CONNECTOR_BLOCKED"]) {
    expect(routing.fail("api", code)).toBe(false)
    expect(routing.route).toBe("direct")
  }
  for (const proxy of ["socks5://user:secret@proxy:1080", "https://proxy:8443", "bad", "http://proxy/path"]) {
    const invalid = createConnectRouting("https://connect.example.com", { HTTP_PROXY: proxy })
    expect(invalid.fail("api", "CONNECTION_FAILED")).toBe(false)
    expect(invalid.diagnostics().proxyError).toMatch(/^PROXY_/)
    expect(JSON.stringify(invalid.diagnostics())).not.toContain("secret")
  }
  expect(networkFailure({ cause: { code: "ENOTFOUND" } })).toBe("DNS_FAILED")
  expect(networkFailure({ code: "CERT_HAS_EXPIRED" })).toBe("TLS_FAILED")
  expect(networkFailure({ name: "AbortError" })).toBeNull()
  expect(networkFailure(new SyntaxError("malformed response"))).toBeNull()
})

test("frpc gets a clean child environment without changing provider/service settings", () => {
  const environment = { http_proxy: "http://proxy:80", HTTPS_PROXY: "http://proxy:80", ALL_PROXY: "socks5://proxy:1080", No_Proxy: "example.com", PATH: "/fixture/bin", MODEL_KEY: "unchanged" }
  const before = { ...environment }
  expect(transportEnvironment(environment)).toEqual({ PATH: "/fixture/bin", MODEL_KEY: "unchanged" })
  expect(environment).toEqual(before)
})
