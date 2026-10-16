import { randomBytes } from "node:crypto"
import path from "node:path"

export const LOCAL_PREVIEW_ASSET_PREFIX = "/_stillon/preview-assets/"
export const REMOTE_PREVIEW_ASSET_PREFIX = "/_connect/preview-assets/"
const extensions = /\.(?:html?|css|[cm]?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp[34]|webm|wav|ogg)$/iu
export function projectPreviewTarget(pathname: string) {
  const match = /^\/api\/projects\/([^/]+)\/preview\/(.+)$/u.exec(pathname)
  if (!match) return null
  try { return { projectId: decodeURIComponent(match[1]!), filePath: match[2]!.split("/").map(decodeURIComponent).join("/") } } catch { return null }
}
function isValid(context: PreviewResourceContext) {
  try { return context.valid() } catch { return false }
}
export interface PreviewResourceContext {
  projectId: string; directory: string; valid: () => boolean
  assetPrefix: string; originalPrefix: string; expiresAt: number
}

/** Short-lived, folder-scoped read capabilities let opaque sandbox documents load assets without app cookies. */
export class PreviewResources {
  private readonly contexts = new Map<string, PreviewResourceContext>()
  constructor(readonly prefix: string, private readonly now = Date.now) {}
  clear() { this.contexts.clear() }
  create(projectId: string, filePath: string, valid: () => boolean = () => true) {
    for (const [token, context] of this.contexts) if (context.expiresAt <= this.now() || !isValid(context)) this.contexts.delete(token)
    while (this.contexts.size >= 128) this.contexts.delete(this.contexts.keys().next().value!)
    const token = randomBytes(24).toString("base64url"), directory = path.posix.dirname(filePath)
    const root = `/api/projects/${encodeURIComponent(projectId)}/preview/`
    const originalPrefix = root + (directory === "." ? "" : directory.split("/").map(encodeURIComponent).join("/") + "/")
    const context = { projectId, directory, valid, originalPrefix, assetPrefix: this.prefix + token + "/", expiresAt: this.now() + 60 * 60 * 1000 }
    this.contexts.set(token, context)
    return context
  }
  resolve(pathname: string): { context: PreviewResourceContext; path: string; filePath: string } | null {
    if (!pathname.startsWith(this.prefix)) return null
    const [token, ...parts] = pathname.slice(this.prefix.length).split("/")
    const context = this.contexts.get(token ?? "")
    if (!context || context.expiresAt <= this.now() || !isValid(context)) return null
    let relative: string
    try { relative = parts.map(decodeURIComponent).join("/") } catch { return null }
    if (!relative || relative.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".") || /[\\\u0000:]/u.test(part)) || !extensions.test(relative)) return null
    const filePath = (context.directory === "." ? "" : context.directory + "/") + relative
    return { context, filePath, path: `/api/projects/${encodeURIComponent(context.projectId)}/preview/${filePath.split("/").map(encodeURIComponent).join("/")}` }
  }
  async wrap(response: Response, request: Request, context: PreviewResourceContext, filePath: string) {
    const headers = new Headers(response.headers)
    headers.set("Cache-Control", "no-store"); headers.set("Referrer-Policy", "no-referrer")
    headers.set("X-Content-Type-Options", "nosniff")
    // A capability grants only this preview folder, never authenticated app APIs.
    headers.set("Access-Control-Allow-Origin", "null")
    const type = headers.get("content-type") ?? ""
    if (/text\/html/iu.test(type)) {
      const source = new URL(request.url).origin + context.assetPrefix
      headers.set("Content-Security-Policy", `sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' ${source} blob:; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src data: ${source}; media-src data: blob: ${source}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri ${source}; form-action 'none'`)
    }
    let body: BodyInit | null = request.method === "HEAD" ? null : response.body
    if (response.ok && request.method !== "HEAD" && /text\/html|text\/css|javascript/iu.test(type)) {
      let text = await response.text()
      text = text.replaceAll(context.originalPrefix, context.assetPrefix)
      if (/text\/html/iu.test(type)) {
        const relative = path.posix.relative(context.directory, path.posix.dirname(filePath))
        const base = context.assetPrefix + (relative && relative !== "." ? relative.split("/").map(encodeURIComponent).join("/") + "/" : "")
        // Install our base before any author-supplied base. CSP limits it to this capability.
        text = text.replace(/<base\b[^>]*>/giu, "")
        const tag = `<base href="${base}">`
        text = /<head\b[^>]*>/iu.test(text) ? text.replace(/<head\b[^>]*>/iu, match => match + tag) : tag + text
      }
      headers.delete("content-length"); headers.delete("content-encoding")
      body = text
    }
    return new Response(body, { status: response.status, headers })
  }
}
