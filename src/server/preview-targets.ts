import { randomBytes } from "node:crypto"
import { readFile, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { parsePreviewTarget, standalonePreviewUrl, type PreviewTarget } from "../shared/preview-target"
import { fileRenderer } from "../shared/file-renderers"

interface Entry { owner: string; projectId?: string; target: PreviewTarget; expiresAt: number }
export class PreviewTargets {
  private readonly entries = new Map<string, Entry>()
  private readonly ready: Promise<void>
  private writes: Promise<void> | null = null
  private dirty = false
  constructor(private readonly storagePath?: string, private readonly resolveHtml?: (address: string, owner: string) => Promise<string>,
    private readonly validateFile?: (target: PreviewTarget) => Promise<void>) {
    this.ready = (async () => {
      if (!storagePath) return
      try {
        const data = JSON.parse(await readFile(storagePath, "utf8"))
        if (!Array.isArray(data)) return
        for (const [id, entry] of data.slice(-1024)) {
          if (typeof id !== "string" || !/^[\w-]{32}$/u.test(id) || typeof entry?.owner !== "string" || entry.expiresAt <= Date.now()) continue
          const target = parsePreviewTarget(entry.target?.address, entry.projectId)
          if (target?.kind === "host-html" && typeof entry.target?.filePath === "string" && path.isAbsolute(entry.target.filePath) && /\.html?$/iu.test(entry.target.filePath)) target.filePath = entry.target.filePath
          if (target && "filePath" in target && typeof entry.target?.canonicalPath === "string" && path.isAbsolute(entry.target.canonicalPath)) target.canonicalPath = entry.target.canonicalPath
          if (target && "filePath" in target && typeof entry.target?.resourceRoot === "string" && path.isAbsolute(entry.target.resourceRoot)) target.resourceRoot = entry.target.resourceRoot
          if (target) this.entries.set(id, { owner: entry.owner, projectId: entry.projectId, target, expiresAt: entry.expiresAt })
        }
      } catch { /* A missing or invalid registry never expands authorization. */ }
    })()
  }
  private persist(changed = true): Promise<void> {
    if (!this.storagePath) return Promise.resolve()
    if (changed) this.dirty = true
    if (!this.dirty && !this.writes) return Promise.resolve()
    // Serialize at flush time, not once for every concurrent link operation.
    // All callers await durable atomic replacement; failures remain visible.
    this.writes ??= Promise.resolve().then(async () => {
      try { while (this.dirty) {
        this.dirty = false
        const contents = JSON.stringify([...this.entries])
        try {
          await writeFile(this.storagePath! + ".tmp", contents, { mode: 0o600 })
          for (let attempt = 0; ; attempt++) {
            try { await rename(this.storagePath! + ".tmp", this.storagePath!); break }
            catch (error) {
              if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
              await Bun.sleep(50)
            }
          }
        } catch (error) { this.dirty = true; throw error }
      } } finally { this.writes = null }
    })
    return this.writes
  }
  clear() { this.entries.clear() }
  get(id: string, owner: string) {
    const entry = this.entries.get(id)
    return entry && entry.owner === owner && entry.expiresAt > Date.now() ? entry : null
  }
  async handle(request: Request, url: URL, owner: string, projectExists: (id: string) => boolean, projectPath?: (id: string) => string | undefined, authorizedHtmlDirectory?: string) {
    if (!url.pathname.startsWith("/api/preview-targets")) return null
    await this.ready
    const resolveOnly = url.pathname === "/api/preview-targets/resolve"
    if ((url.pathname === "/api/preview-targets" || resolveOnly) && request.method === "POST") {
      let body: any
      try { body = await request.json() } catch { return Response.json({ error: "Invalid preview target" }, { status: 400 }) }
      const projectId = typeof body?.projectId === "string" ? body.projectId : undefined
      const target = typeof body?.address === "string" ? parsePreviewTarget(body.address, projectId) : null
      if (!target || (projectId && !projectExists(projectId)) || (target.kind === "project-file" && !projectExists(target.projectId))) return Response.json({ error: "Preview target is unavailable" }, { status: 400 })
      if (target.kind === "external-http") return Response.json({ error: "External websites open in your browser." }, { status: 400 })
      if (target.kind === "host-html" && this.resolveHtml) {
        const existing = [...this.entries.values()].find(entry => entry.owner === owner && entry.expiresAt > Date.now() && entry.target.address === target.address && entry.target.kind === "host-html")
        try { target.filePath = existing?.target.kind === "host-html" && existing.target.filePath ? existing.target.filePath : await this.resolveHtml(target.address, owner) }
        catch { return Response.json({ error: "HTML preview expired. Reopen the original file." }, { status: 410 }) }
      }
      if (this.validateFile) {
        const prior = [...this.entries.values()].find(entry => entry.owner === owner && entry.projectId === projectId && entry.expiresAt > Date.now() && entry.target.address === target.address)
        if ("filePath" in target && prior && "filePath" in prior.target) {
          target.canonicalPath = prior.target.canonicalPath
          target.resourceRoot = prior.target.resourceRoot
        }
        // This argument is supplied only after the server validates a link from
        // an existing HTML grant. JSON request fields cannot authorize a folder.
        if (authorizedHtmlDirectory && "filePath" in target && fileRenderer(target.filePath ?? "") === "html") {
          const relation = target.resourceRoot ? path.relative(target.resourceRoot, authorizedHtmlDirectory) : ".."
          if (!target.resourceRoot || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) target.resourceRoot = authorizedHtmlDirectory
        }
        try { await this.validateFile(target) }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : "File unavailable" }, { status: error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 403 }) }
      }
      const directory = "directory" in target && target.directory === true
      const renderer = !directory && "filePath" in target ? fileRenderer(target.canonicalPath ?? target.filePath ?? "") : undefined
      const capabilities = "filePath" in target ? { directory, renderer, canRead: true, canPreview: Boolean(renderer), canDownload: !directory } : {}
      if (resolveOnly) return Response.json({ kind: directory ? "directory" : "filePath" in target ? "file" : "service", canRead: true, canPreview: target.kind === "host-http" || Boolean(renderer), canDownload: "filePath" in target && !directory, ...capabilities }, { headers: { "Cache-Control": "no-store" } })
      for (const [id, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.entries.delete(id)
      for (const [id, entry] of this.entries) if (entry.owner === owner && entry.projectId === projectId && entry.target.address === target.address) {
        const changed = JSON.stringify(entry.target) !== JSON.stringify(target) || entry.expiresAt < Date.now() + 29 * 24 * 60 * 60_000
        if (changed) {
          entry.target = target
          entry.expiresAt = Date.now() + 30 * 24 * 60 * 60_000
        }
        await this.persist(changed)
        return Response.json({ id, url: standalonePreviewUrl(id), target, projectId, projectLocalPath: projectId ? projectPath?.(projectId) : undefined, ...capabilities }, { headers: { "Cache-Control": "no-store" } })
      }
      if (this.entries.size >= 1024) return Response.json({ error: "Preview target limit reached" }, { status: 429 })
      const id = randomBytes(24).toString("base64url")
      this.entries.set(id, { owner, target, projectId, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 })
      await this.persist()
      return Response.json({ id, url: standalonePreviewUrl(id), target, projectId, projectLocalPath: projectId ? projectPath?.(projectId) : undefined, ...capabilities }, { status: 201, headers: { "Cache-Control": "no-store" } })
    }
    const match = /^\/api\/preview-targets\/([\w-]+)$/u.exec(url.pathname)
    if (!match) return null
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } })
    const entry = this.get(match[1]!, owner)
    return entry ? Response.json({ target: entry.target, projectId: entry.projectId,
      projectLocalPath: entry.projectId ? projectPath?.(entry.projectId) : undefined }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "Preview expired or unavailable. Open the original link again." }, { status: 410 })
  }
}
