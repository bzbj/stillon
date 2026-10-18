import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { PreviewFiles } from "./preview-files"
import { PreviewTargets } from "./preview-targets"
import { parsePreviewTarget } from "../shared/preview-target"
import { buildLocalFilePreviewUrl } from "../shared/local-file-urls"
import { buildProjectFilePreviewUrl } from "../shared/project-file-urls"

test("file targets read exact bytes; direct HTML isolates origin and authorizes only its directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-file-v2-")), folder = path.join(root, "authorized")
  const files = new PreviewFiles(id => id === "workspace" ? folder : undefined)
  let valid = true
  try {
    await mkdir(folder)
    await writeFile(path.join(folder, "index.html"), '<!doctype html><head></head><input><script type="module" src="/module.mjs"></script>')
    await writeFile(path.join(folder, "module.mjs"), "document.body.dataset.loaded='yes'")
    await writeFile(path.join(folder, "data.json"), '{"label":"中文"}')
    await writeFile(path.join(folder, "raw.docx"), Buffer.from([0, 1, 2, 255]))
    await mkdir(path.join(folder, "nested"))
    await writeFile(path.join(folder, "nested", "next.html"), '<!doctype html><script type="module" src="/module.mjs"></script>')
    await writeFile(path.join(root, "private.json"), '{"private":true}')
    const target = parsePreviewTarget(buildLocalFilePreviewUrl(path.join(folder, "index.html")))!
    await files.authorize(target)
    const sibling = buildLocalFilePreviewUrl(path.join(folder, "raw.docx"))
    expect(await files.linkedAddress(target, sibling)).toEqual({ address: sibling, directory: folder })
    await expect(files.linkedAddress(target, buildLocalFilePreviewUrl(path.join(root, "private.json")))).rejects.toThrow("outside the authorized HTML directory")
    const entry = new URL(await files.localEntry(target, "local", "http://localhost:3210", () => valid))
    expect(entry.hostname).toMatch(/^f-[a-f0-9]{48}\.localhost$/u)
    const childAddress = buildLocalFilePreviewUrl(path.join(folder, "nested", "next.html"))
    const linked = await files.linkedAddress(target, childAddress)
    const storage = path.join(root, "targets.json"), registry = new PreviewTargets(storage, undefined, target => files.authorize(target))
    const registration = new Request("http://localhost/api/preview-targets", { method: "POST", body: JSON.stringify({ address: childAddress }) })
    const registered = await registry.handle(registration, new URL(registration.url), "local", () => true, undefined, linked.directory)
    expect(registered?.status).toBe(201)
    const { id } = await registered!.json(), read = new Request("http://localhost/api/preview-targets/" + id)
    const restarted = new PreviewTargets(storage, undefined, target => files.authorize(target))
    const descriptor = await (await restarted.handle(read, new URL(read.url), "local", () => true))!.json()
    const child = descriptor.target
    expect(child.resourceRoot).toBe(folder)
    const childEntry = new URL(await files.localEntry(child, "local", "http://localhost:3210", () => valid))
    expect(childEntry.origin).toBe(entry.origin)
    expect(childEntry.pathname).toBe("/nested/next.html")
    const request = (resource: string) => fetch(`http://127.0.0.1:${entry.port}${resource}`, { headers: { Host: entry.host } })
    const html = await request(entry.pathname)
    expect(html.status).toBe(200)
    expect(html.headers.has("set-cookie")).toBe(false)
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'self'")
    expect(await html.text()).toContain('type="module"')
    expect(await (await request("/data.json")).json()).toEqual({ label: "中文" })
    expect((await request("/module.mjs")).headers.get("content-type")).toContain("javascript")
    expect((await request("/%2e%2e%2fprivate.json")).status).toBe(403)
    expect((await request("/api/projects")).status).not.toBe(200)
    const office = parsePreviewTarget(buildLocalFilePreviewUrl(path.join(folder, "raw.docx")))!
    await files.authorize(office)
    const bytes = await files.content(new Request("http://stillon.invalid"), office, true)
    expect(bytes.headers.get("content-disposition")).toContain("raw.docx")
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([0, 1, 2, 255])
    expect((await files.content(new Request("http://stillon.invalid"), office, false)).status).toBe(415)
    valid = false
    expect((await request("/data.json")).status).toBe(410)
  } finally { await files.close(); await rm(root, { recursive: true, force: true }) }
})

test("HTML links cannot expand their canonical directory via a junction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-file-scope-"))
  const files = new PreviewFiles(() => root)
  try {
    const html = path.join(root, "html"), other = path.join(root, "other")
    await mkdir(html); await mkdir(other)
    await writeFile(path.join(html, "index.html"), "<!doctype html><p>Preview</p>")
    await writeFile(path.join(other, "private.html"), "private")
    await symlink(other, path.join(html, "linked"), process.platform === "win32" ? "junction" : "dir")
    const target = parsePreviewTarget(buildProjectFilePreviewUrl("workspace", "html/index.html"))!
    await files.authorize(target)
    // Both files are inside the project. Only the HTML document's own folder is granted.
    await expect(files.linkedAddress(target, buildProjectFilePreviewUrl("workspace", "html/linked/private.html"))).rejects.toThrow("outside the authorized HTML directory")
  } finally { await files.close(); await rm(root, { recursive: true, force: true }) }
})
