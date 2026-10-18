import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PreviewTargets } from "./preview-targets"

test("opaque targets require the same authenticated owner and survive a server restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-preview-targets-"))
  try {
    const file = path.join(root, "targets.json")
    const registry = new PreviewTargets(file)
    const create = new Request("http://localhost/api/preview-targets", { method: "POST", body: JSON.stringify({ address: "/api/local-files/markdown-preview/%2Ftmp%2Freport.md" }) })
    const created = await registry.handle(create, new URL(create.url), "account-one", () => true)
    expect(created?.status).toBe(201)
    const { id, url } = await created!.json()
    expect(url).toBe("/preview/" + id)
    expect(url).not.toContain("report.md")
    const read = new Request("http://localhost/api/preview-targets/" + id)
    const restarted = new PreviewTargets(file)
    expect((await restarted.handle(read, new URL(read.url), "account-two", () => true))?.status).toBe(410)
    expect((await restarted.handle(read, new URL(read.url), "account-one", () => true))?.status).toBe(200)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("concurrent link resolution persists every owner-bound target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-preview-targets-"))
  try {
    const file = path.join(root, "targets.json"), registry = new PreviewTargets(file)
    const targets = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const request = new Request("http://localhost/api/preview-targets", { method: "POST", body: JSON.stringify({ address: `/api/local-files/markdown-preview/%2Ftmp%2Fguide-${index}.md` }) })
      const response = await registry.handle(request, new URL(request.url), "account-one", () => true)
      expect(response?.status).toBe(201)
      return response!.json()
    }))
    const restarted = new PreviewTargets(file)
    for (const target of targets) {
      const request = new Request("http://localhost/api/preview-targets/" + target.id)
      expect((await restarted.handle(request, new URL(request.url), "account-one", () => true))?.status).toBe(200)
      expect((await restarted.handle(request, new URL(request.url), "account-two", () => true))?.status).toBe(410)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("client JSON cannot supply an HTML resource directory", async () => {
  let directory: string | undefined = "unexpected"
  const registry = new PreviewTargets(undefined, undefined, async target => { directory = "resourceRoot" in target ? target.resourceRoot : undefined })
  const request = new Request("http://localhost/api/preview-targets", { method: "POST", body: JSON.stringify({ address: "/api/local-files/preview/%2Ftmp%2Findex.html", resourceRoot: "/private" }) })
  expect((await registry.handle(request, new URL(request.url), "account-one", () => true))?.status).toBe(201)
  expect(directory).toBeUndefined()
})
