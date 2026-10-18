import { randomBytes } from "node:crypto"
import { readFile, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { parsePreviewTarget, standalonePreviewUrl, type PreviewTarget } from "../shared/preview-target"

interface Entry { owner: string; projectId?: string; target: PreviewTarget; expiresAt: number }
export class PreviewTargets {
  private readonly entries = new Map<string, Entry>()
  private readonly ready: Promise<void>
  private writes = Promise.resolve()
  constructor(private readonly storagePath?: string, private readonly resolveHtml?: (address: string, owner: string) => Promise<string>) {
    this.ready = (async () => {
      if (!storagePath) return
      try {
        const data = JSON.parse(await readFile(storagePath, "utf8"))
        if (!Array.isArray(data)) return
        for (const [id, entry] of data.slice(-1024)) {
          if (typeof id !== "string" || !/^[\w-]{32}$/u.test(id) || typeof entry?.owner !== "string" || entry.expiresAt <= Date.now()) continue
          const target = parsePreviewTarget(entry.target?.address, entry.projectId)
          if (target?.kind === "host-html" && typeof entry.target?.filePath === "string" && path.isAbsolute(entry.target.filePath) && /\.html?$/iu.test(entry.target.filePath)) target.filePath = entry.target.filePath
          if (target) this.entries.set(id, { owner: entry.owner, projectId: entry.projectId, target, expiresAt: entry.expiresAt })
        }
      } catch { /* A missing or invalid registry never expands authorization. */ }
    })()
  }
  private persist() {
    if (!this.storagePath) return Promise.resolve()
    const contents = JSON.stringify([...this.entries])
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await writeFile(this.storagePath! + ".tmp", contents, { mode: 0o600 })
      await rename(this.storagePath! + ".tmp", this.storagePath!)
    })
    return this.writes
  }
  clear() { this.entries.clear() }
  get(id: string, owner: string) {
    const entry = this.entries.get(id)
    return entry && entry.owner === owner && entry.expiresAt > Date.now() ? entry : null
  }
  async handle(request: Request, url: URL, owner: string, projectExists: (id: string) => boolean) {
    if (!url.pathname.startsWith("/api/preview-targets")) return null
    await this.ready
    if (url.pathname === "/api/preview-targets" && request.method === "POST") {
      let body: any
      try { body = await request.json() } catch { return Response.json({ error: "Invalid preview target" }, { status: 400 }) }
      const projectId = typeof body?.projectId === "string" ? body.projectId : undefined
      const target = typeof body?.address === "string" ? parsePreviewTarget(body.address, projectId) : null
      if (!target || (projectId && !projectExists(projectId))) return Response.json({ error: "Preview target is unavailable" }, { status: 400 })
      for (const [id, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.entries.delete(id)
      for (const [id, entry] of this.entries) if (entry.owner === owner && entry.projectId === projectId && entry.target.address === target.address) {
        entry.expiresAt = Date.now() + 30 * 24 * 60 * 60_000
        await this.persist()
        return Response.json({ id, url: standalonePreviewUrl(id) }, { headers: { "Cache-Control": "no-store" } })
      }
      if (this.entries.size >= 1024) return Response.json({ error: "Preview target limit reached" }, { status: 429 })
      if (target.kind === "host-html" && this.resolveHtml) {
        try { target.filePath = await this.resolveHtml(target.address, owner) }
        catch { return Response.json({ error: "HTML preview expired. Reopen the original file." }, { status: 410 }) }
      }
      const id = randomBytes(24).toString("base64url")
      this.entries.set(id, { owner, target, projectId, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 })
      await this.persist()
      return Response.json({ id, url: standalonePreviewUrl(id) }, { status: 201, headers: { "Cache-Control": "no-store" } })
    }
    const match = /^\/api\/preview-targets\/([\w-]+)$/u.exec(url.pathname)
    if (!match) return null
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } })
    const entry = this.get(match[1]!, owner)
    return entry ? Response.json({ target: entry.target, projectId: entry.projectId }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Preview expired or unavailable. Open the original link again." }, { status: 410 })
  }
}
