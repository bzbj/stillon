import { expect, test } from "bun:test"
import { validateIngress } from "./ingress"
import { REMOTE_HEADER, REMOTE_OWNER_HEADER } from "./adapter"
const options = { port: 4321, hostname: "127.0.0.1", peer: "127.0.0.1", secret: "x".repeat(43) }
const request = (route: string, headers: Record<string, string> = {}, method = "GET") => new Request(`http://127.0.0.1:4321${route}`, { method, headers })
test("fullscreen navigation and capability reads do not authorize cross-site app requests", () => {
  const navigation = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" }
  expect(validateIngress(request("/api/projects/p/preview/index.html", navigation), options)).toEqual({ kind: "local" })
  expect((validateIngress(request("/api/projects/p/preview/index.html", { "sec-fetch-site": "cross-site" }), options) as Response).status).toBe(403)
  expect((validateIngress(request("/api/projects/p/files", navigation), options) as Response).status).toBe(403)
  expect(validateIngress(request("/_stillon/preview-assets/token/app.js", { origin: "null", "sec-fetch-site": "cross-site" }), options)).toEqual({ kind: "external" })
  expect((validateIngress(request("/_stillon/preview-assets/token/app.js", { origin: "null" }, "POST"), options) as Response).status).toBe(403)
  expect((validateIngress(request("/_stillon/preview-assets/token/app.js", { host: "evil.example" }), options) as Response).status).toBe(403)
})

test("opaque standalone top-level navigation preserves API, origin and framing boundaries", () => {
  const route = "/preview/" + "x".repeat(32)
  const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }
  expect(validateIngress(request(route, navigation), options)).toEqual({ kind: "local" })
  for (const value of [request(route, { ...navigation, "sec-fetch-dest": "iframe" }), request(route, { ...navigation, "sec-fetch-mode": "cors" }),
    request(route, { ...navigation, origin: "https://evil.example" }), request(route, navigation, "POST"),
    request("/api/preview-targets/" + "x".repeat(32), navigation), request(route, { ...navigation, host: "evil.example" })]) {
    expect((validateIngress(value, options) as Response).status).toBe(403)
  }
})
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
