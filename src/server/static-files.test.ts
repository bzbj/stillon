import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getStaticHeaders, serveStatic } from "./static-files"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

async function createClientDist() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stillon-static-files-"))
  temporaryDirectories.push(directory)
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Still On</title>", "utf8")
  return directory
}

describe("production static files", () => {
  test("serves the stable worker with revalidation and root scope headers", async () => {
    const directory = await createClientDist()
    await writeFile(path.join(directory, "service-worker.js"), "self.addEventListener('fetch', () => {})", "utf8")

    const response = await serveStatic(directory, "/service-worker.js")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/javascript")
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(response.headers.get("cache-control")).toContain("no-transform")
    expect(response.headers.get("service-worker-allowed")).toBe("/")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("never disguises a missing worker or hashed asset as SPA HTML", async () => {
    const directory = await createClientDist()

    for (const pathname of ["/service-worker.js", "/assets/missing-AAAAAAAA.js"]) {
      const response = await serveStatic(directory, pathname)
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("text/plain")
      expect(await response.text()).not.toContain("<!doctype html>")
    }
  })

  test("keeps HTML network responses out of HTTP caches", () => {
    expect(new Headers(getStaticHeaders("/index.html")).get("cache-control")).toBe("no-store, no-transform")
  })

  test("asks ingress proxies not to transform integrity-checked assets", () => {
    expect(new Headers(getStaticHeaders("/assets/app-12345678.js")).get("cache-control"))
      .toBe("no-transform")
  })
})
