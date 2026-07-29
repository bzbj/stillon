import { afterEach, describe, expect, test } from "bun:test"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { precompressStaticAssets } from "../../scripts/precompress-static-assets"
import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  REVALIDATE_ASSET_CACHE_CONTROL,
  isContentHashedBuildAssetPath,
  serveStaticAsset,
} from "./static-assets"

const tempDirs: string[] = []

async function createTempDist() {
  const distDir = await mkdtemp(path.join(tmpdir(), "stillon-static-assets-"))
  tempDirs.push(distDir)
  await mkdir(path.join(distDir, "assets"), { recursive: true })
  await writeFile(path.join(distDir, "index.html"), "<!doctype html><title>Still On</title><main>shell</main>", "utf8")
  return distDir
}

function request(pathname: string, headers?: HeadersInit, method = "GET") {
  return new Request(`http://stillon.test${pathname}`, { method, headers })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("static asset cache classification", () => {
  test("only classifies Vite assets with the configured content hash", () => {
    expect(isContentHashedBuildAssetPath("/assets/index-0123456789ab.js")).toBe(true)
    expect(isContentHashedBuildAssetPath("/assets/body-abcdef012345.woff2")).toBe(true)
    expect(isContentHashedBuildAssetPath("/assets/index.js")).toBe(false)
    expect(isContentHashedBuildAssetPath("/fonts/body-abcdef012345.woff2")).toBe(false)
    expect(isContentHashedBuildAssetPath("/index.html")).toBe(false)
  })

  test("uses immutable caching for hashed assets and revalidation elsewhere", async () => {
    const distDir = await createTempDist()
    await writeFile(path.join(distDir, "assets", "app-0123456789ab.js"), "export const ready = true\n", "utf8")
    await writeFile(path.join(distDir, "assets", "app.js"), "export const mutable = true\n", "utf8")

    const immutable = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js"),
      "/assets/app-0123456789ab.js",
    )
    const mutable = await serveStaticAsset(distDir, request("/assets/app.js"), "/assets/app.js")
    const html = await serveStaticAsset(distDir, request("/"), "/")
    const fallback = await serveStaticAsset(distDir, request("/chat/example"), "/chat/example")

    expect(immutable.headers.get("cache-control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
    expect(mutable.headers.get("cache-control")).toBe(REVALIDATE_ASSET_CACHE_CONTROL)
    expect(html.headers.get("cache-control")).toBe(REVALIDATE_ASSET_CACHE_CONTROL)
    expect(fallback.headers.get("cache-control")).toBe(REVALIDATE_ASSET_CACHE_CONTROL)
    expect(fallback.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await fallback.text()).toContain("<main>shell</main>")
  })
})

describe("static asset precompression and negotiation", () => {
  test("writes Brotli and gzip sidecars only for worthwhile compressible files", async () => {
    const distDir = await createTempDist()
    const script = "const repeated = 'startup payload';\n".repeat(400)
    const font = new Uint8Array(4_096).fill(7)
    await writeFile(path.join(distDir, "assets", "app-0123456789ab.js"), script, "utf8")
    await writeFile(path.join(distDir, "assets", "body-abcdef012345.woff2"), font)

    const summary = await precompressStaticAssets(distDir)
    const scriptResult = summary.assets.find((asset) => asset.relativePath === "assets/app-0123456789ab.js")

    expect(scriptResult?.brotliBytes).toBeLessThan(script.length)
    expect(scriptResult?.gzipBytes).toBeLessThan(script.length)
    expect(await Bun.file(path.join(distDir, "assets", "app-0123456789ab.js.br")).exists()).toBe(true)
    expect(await Bun.file(path.join(distDir, "assets", "app-0123456789ab.js.gz")).exists()).toBe(true)
    expect(await Bun.file(path.join(distDir, "assets", "body-abcdef012345.woff2.br")).exists()).toBe(false)
    expect(await Bun.file(path.join(distDir, "assets", "body-abcdef012345.woff2.gz")).exists()).toBe(false)
    expect(brotliDecompressSync(await Bun.file(path.join(distDir, "assets", "app-0123456789ab.js.br")).bytes()).toString())
      .toBe(script)
    expect(gunzipSync(await Bun.file(path.join(distDir, "assets", "app-0123456789ab.js.gz")).bytes()).toString())
      .toBe(script)
  })

  test("prefers Brotli, falls back to gzip or identity, and varies by encoding", async () => {
    const distDir = await createTempDist()
    const script = "console.log('compressed startup');\n".repeat(400)
    const assetPath = path.join(distDir, "assets", "app-0123456789ab.js")
    await writeFile(assetPath, script, "utf8")
    await precompressStaticAssets(distDir)

    const brotli = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "gzip, br" }),
      "/assets/app-0123456789ab.js",
    )
    const gzip = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br;q=0, gzip" }),
      "/assets/app-0123456789ab.js",
    )
    const identity = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br;q=0, gzip;q=0" }),
      "/assets/app-0123456789ab.js",
    )

    expect(brotli.headers.get("content-encoding")).toBe("br")
    expect(brotli.headers.get("vary")).toBe("Accept-Encoding")
    expect(brotli.headers.get("content-type")).toContain("javascript")
    expect(brotliDecompressSync(await brotli.bytes()).toString()).toBe(script)
    expect(gzip.headers.get("content-encoding")).toBe("gzip")
    expect(gunzipSync(await gzip.bytes()).toString()).toBe(script)
    expect(identity.headers.get("content-encoding")).toBeNull()
    expect(await identity.text()).toBe(script)
  })

  test("falls through missing precompressed variants without failing the asset", async () => {
    const distDir = await createTempDist()
    const script = "console.log('variant fallback');\n".repeat(400)
    const assetPath = path.join(distDir, "assets", "app-0123456789ab.js")
    await writeFile(assetPath, script, "utf8")
    await precompressStaticAssets(distDir)
    await rm(`${assetPath}.br`)

    const gzip = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br, gzip" }),
      "/assets/app-0123456789ab.js",
    )
    const gzipText = gunzipSync(await gzip.bytes()).toString()
    await rm(`${assetPath}.gz`)
    const identity = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br, gzip" }),
      "/assets/app-0123456789ab.js",
    )

    expect(gzip.status).toBe(200)
    expect(gzip.headers.get("content-encoding")).toBe("gzip")
    expect(gzipText).toBe(script)
    expect(identity.status).toBe(200)
    expect(identity.headers.get("content-encoding")).toBeNull()
    expect(await identity.text()).toBe(script)
  })

  test("returns 406 when every available representation is unacceptable", async () => {
    const distDir = await createTempDist()
    await writeFile(path.join(distDir, "assets", "app-0123456789ab.js"), "export default true\n".repeat(100), "utf8")
    await precompressStaticAssets(distDir)

    const response = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", {
        "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=0",
      }),
      "/assets/app-0123456789ab.js",
    )

    expect(response.status).toBe(406)
  })
})

describe("static asset HTTP semantics", () => {
  test("validates ETags, preserves representation headers, and handles HEAD", async () => {
    const distDir = await createTempDist()
    const assetPath = path.join(distDir, "assets", "app-0123456789ab.js")
    await writeFile(assetPath, "export const value = 42\n".repeat(100), "utf8")
    await precompressStaticAssets(distDir)

    const first = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br" }),
      "/assets/app-0123456789ab.js",
    )
    const etag = first.headers.get("etag")
    expect(etag).toBeTruthy()

    const notModified = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", {
        "Accept-Encoding": "br",
        "If-None-Match": etag!,
      }),
      "/assets/app-0123456789ab.js",
    )
    const head = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js", { "Accept-Encoding": "br" }, "HEAD"),
      "/assets/app-0123456789ab.js",
    )

    expect(notModified.status).toBe(304)
    expect(notModified.headers.get("etag")).toBe(etag)
    expect(notModified.headers.get("cache-control")).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
    expect(notModified.headers.get("vary")).toBe("Accept-Encoding")
    expect(notModified.headers.get("content-encoding")).toBe("br")
    expect(await notModified.text()).toBe("")
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe(String(Bun.file(`${assetPath}.br`).size))
    expect(await head.text()).toBe("")
  })

  test("keeps Bun file range responses and the original MIME type for encoded files", async () => {
    const distDir = await createTempDist()
    const assetPath = path.join(distDir, "assets", "app-0123456789ab.js")
    const script = "0123456789abcdefghijklmnopqrstuvwxyz"
    await writeFile(assetPath, script, "utf8")

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const pathname = new URL(req.url).pathname
        return serveStaticAsset(distDir, req, pathname)
      },
    })

    try {
      const response = await fetch(new URL("/assets/app-0123456789ab.js", server.url), {
        headers: {
          "Accept-Encoding": "identity",
          Range: "bytes=5-12",
        },
      })
      expect(response.status).toBe(206)
      expect(response.headers.get("content-range")).toBe(`bytes 5-12/${script.length}`)
      expect(response.headers.get("content-type")).toContain("javascript")
      expect(await response.text()).toBe(script.slice(5, 13))

      const unsatisfiable = await fetch(new URL("/assets/app-0123456789ab.js", server.url), {
        headers: {
          "Accept-Encoding": "identity",
          Range: "bytes=99-",
        },
      })
      expect(unsatisfiable.status).toBe(416)
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${script.length}`)

      const ifRangeMismatch = await fetch(new URL("/assets/app-0123456789ab.js", server.url), {
        headers: {
          "Accept-Encoding": "identity",
          "If-Range": "\"different-representation\"",
          Range: "bytes=5-12",
        },
      })
      expect(ifRangeMismatch.status).toBe(200)
      expect(ifRangeMismatch.headers.get("content-range")).toBeNull()
      expect(await ifRangeMismatch.text()).toBe(script)
    } finally {
      server.stop()
    }
  })

  test("does not expose sidecars or turn missing asset requests into the SPA shell", async () => {
    const distDir = await createTempDist()
    await writeFile(path.join(distDir, "assets", "app-0123456789ab.js"), "export default true\n".repeat(100), "utf8")
    await precompressStaticAssets(distDir)

    const sidecar = await serveStaticAsset(
      distDir,
      request("/assets/app-0123456789ab.js.br"),
      "/assets/app-0123456789ab.js.br",
    )
    const missingAsset = await serveStaticAsset(
      distDir,
      request("/assets/missing-0123456789ab.js"),
      "/assets/missing-0123456789ab.js",
    )
    const traversal = await serveStaticAsset(
      distDir,
      request("/..%2Fpackage.json"),
      "/..%2Fpackage.json",
    )
    await rm(path.join(distDir, "index.html"))
    const missingBundle = await serveStaticAsset(distDir, request("/"), "/")

    expect(sidecar.status).toBe(404)
    expect(missingAsset.status).toBe(404)
    expect(traversal.status).toBe(404)
    expect(missingBundle.status).toBe(503)
    expect(await missingAsset.text()).not.toContain("<main>shell</main>")
  })
})
