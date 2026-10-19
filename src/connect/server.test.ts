import { expect, test } from "bun:test"
import { connectPeerKey, startConnectServer } from "./server"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"

test("IP budgets group IPv6 privacy addresses by subnet and normalize mapped IPv4", () => {
  expect(connectPeerKey("::ffff:192.0.2.10")).toBe("192.0.2.10")
  expect(connectPeerKey("2001:db8:1234:5678::1")).toBe(connectPeerKey("2001:0db8:1234:5678:1111:2222:3333:4444"))
  expect(connectPeerKey("2001:db8::1")).not.toBe(connectPeerKey("2001:db8:1::1"))
})

test("built portal assets negotiate compression without changing HTML, caching or CSP", async () => {
  const dist = path.resolve("dist/connect")
  const index = await readFile(path.join(dist, "index.html"), "utf8")
  const assets = [...new Set([...index.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]!))]
  expect(assets.length).toBeGreaterThan(0)
  const base = path.resolve("test-artifacts/connect-compression")
  await mkdir(base, { recursive: true })
  const dataDir = await mkdtemp(path.join(base, "portal-"))
  const server = await startConnectServer({ origin: "https://connect.example.com", port: 0, dataDir,
    secret: randomBytes(32).toString("hex"), sender: { async send() { throw new Error("No mail in static asset checks") } } })
  const request = (url: string, encoding: string, options: { method?: string; etag?: string } = {}) =>
    fetch(`http://127.0.0.1:${server.port}${url}`, { method: options.method,
      headers: { Host: "connect.example.com", "Accept-Encoding": encoding, ...(options.etag ? { "If-None-Match": options.etag } : {}) },
      decompress: false })
  try {
    for (const asset of assets) {
      const original = await readFile(path.join(dist, asset.slice(1)))
      for (const encoding of ["br", "gzip", "identity"] as const) {
        const response = await request(asset, encoding)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBe(encoding === "identity" ? null : encoding)
        expect(response.headers.get("vary")).toBe("Accept-Encoding")
        expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
        expect(response.headers.get("content-security-policy")).toContain("script-src 'self';")
        const bytes = Buffer.from(await response.arrayBuffer())
        const decoded = encoding === "br" ? brotliDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes
        expect(decoded.equals(original)).toBe(true)
        if (encoding !== "identity") expect(bytes.length).toBeLessThan(original.length)
        const head = await request(asset, encoding, { method: "HEAD" })
        expect(head.status).toBe(200)
        expect(head.headers.get("content-length")).toBe(String(bytes.length))
        expect((await head.arrayBuffer()).byteLength).toBe(0)
        const revalidated = await request(asset, encoding, { etag: response.headers.get("etag")! })
        expect(revalidated.status).toBe(304)
        expect(revalidated.headers.get("vary")).toBe("Accept-Encoding")
      }
      expect((await request(asset, "gzip;q=1, br;q=0.5")).headers.get("content-encoding")).toBe("gzip")
      expect((await request(asset, "identity;q=0, gzip;q=0, br;q=0")).status).toBe(406)
      expect((await request(asset + ".br", "identity")).status).toBe(404)
      expect((await request(asset + ".gz", "identity")).status).toBe(404)
    }
    const html = await request("/authorize?flow=example", "br")
    expect(html.status).toBe(200)
    expect(html.headers.get("cache-control")).toBe("no-store")
    expect(await html.text()).toBe(index)
  } finally {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
