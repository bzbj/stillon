import { expect, test } from "bun:test"
import { isPublicPreviewAddress, resolvePreviewNetworkTarget, createPreviewNetworkProxy } from "./preview-network"
import { isAllowedBrowserPreviewPort } from "./browser-preview-proxy"
import { protectPreviewPort, releasePreviewPort } from "./preview-ports"

test("network policy rejects private, mapped, metadata and alternate protocol targets", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicPreviewAddress(ip)).toBe(false)
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicPreviewAddress(ip)).toBe(true)
  expect(isPublicPreviewAddress("192.0.78.24")).toBe(true)
  for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:2::1", "3fff:1::1"]) expect(isPublicPreviewAddress(ip)).toBe(false)
  for (const url of ["http://127.0.0.1:3210/", "file:///tmp/file", "http://user:secret@localhost:5173/", "http://127.0.0.1:5174/"]) await expect(resolvePreviewNetworkTarget(new URL(url), [3210], "http://127.0.0.1:5173")).rejects.toBeDefined()
})

test("explicit authorized preview ports do not depend on title, root status or negative discovery cache", async () => {
  const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/app" ? new Response("<button>Counter</button>") : new Response("Not found", { status: 404 }) })
  try {
    const port = app.port!
    expect(await isAllowedBrowserPreviewPort(port)).toBe(true)
    protectPreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(false)
    protectPreviewPort(port)
    releasePreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(false)
    releasePreviewPort(port)
    expect(await isAllowedBrowserPreviewPort(port)).toBe(true)
    const proxy = await createPreviewNetworkProxy(() => [3210], `http://127.0.0.1:${port}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/app`, { proxy: { url: proxy.server, headers: { "Proxy-Authorization": "Basic " + btoa(proxy.username + ":" + proxy.password) } } } as any)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Counter")
    } finally { await proxy.close() }
  } finally { await app.stop(true) }
})
test("file previews deny network egress even through transports outside HTTP route interception", async () => {
  const proxy = await createPreviewNetworkProxy(() => [], undefined, true)
  try {
    const response = await fetch("http://example.com/", { proxy: { url: proxy.server, headers: { "Proxy-Authorization": "Basic " + btoa(proxy.username + ":" + proxy.password) } } } as any)
    expect(response.status).toBe(403)
    expect(response.headers.get("x-stillon-preview-transport")).toBe("denied")
  } finally { await proxy.close() }
})
