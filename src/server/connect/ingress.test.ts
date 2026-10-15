import { expect, test } from "bun:test"
import { validateIngress } from "./ingress"
import { REMOTE_HEADER, REMOTE_OWNER_HEADER } from "./adapter"
const options = { port: 4321, hostname: "127.0.0.1", peer: "127.0.0.1", secret: "x".repeat(43) }
const request = (route: string, headers: Record<string, string> = {}, method = "GET") => new Request(`http://127.0.0.1:4321${route}`, { method, headers })
test("local loopback UI needs no account, but Host, Origin and WebSocket are enforced", () => {
  expect(validateIngress(request("/"), options)).toEqual({ kind: "local" })
  for (const input of [request("/", { host: "evil.example" }), request("/", { origin: "https://evil.example" }),
    request("/api/connect-local/enroll", {}, "POST"), request("/ws"), request("/api/test", { origin: "null" }, "POST")]) {
    expect((validateIngress(input, options) as Response).status).toBe(403)
  }
  expect(validateIngress(request("/ws", { origin: "http://127.0.0.1:4321" }), options)).toEqual({ kind: "local" })
})
test("a loopback proxy does not grant local privileges, and remote controls remain local-only", () => {
  const headers = { [REMOTE_HEADER]: options.secret, [REMOTE_OWNER_HEADER]: "account" }
  expect(validateIngress(request("/ws", headers), options)).toEqual({ kind: "remote", ownerId: "account" })
  expect((validateIngress(request("/ws", { ...headers, [REMOTE_HEADER]: "wrong" }), options) as Response).status).toBe(403)
  for (const route of ["/_stillon/update/prepare", "/api/connect-local/unbind", "/api/browser-proxy/3220/", "/auth/login"]) {
    expect((validateIngress(request(route, headers), options) as Response).status).toBe(403)
  }
  expect((validateIngress(request("/ws", headers), { ...options, peer: "192.0.2.5" }) as Response).status).toBe(403)
  expect((validateIngress(request("/ws", { "x-forwarded-for": "127.0.0.1" }), options) as Response).status).toBe(403)
})
