import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import type { PreviewTarget } from "../shared/preview-target"
import { fileRenderer, imageContentType, FILE_PREVIEW_MAX_BYTES } from "../shared/file-renderers"
import { inferProjectFileContentType } from "./uploads"
import { resolveLocalPath } from "./paths"
import { isWithinPreviewDirectory } from "./preview-browser"
import { protectPreviewPort, releasePreviewPort, protectedPreviewPorts } from "./preview-ports"
import { openExternal } from "./external-open"
import { spawnDetached } from "./process-utils"
import { filePreviewCsp } from "../shared/file-preview-security"
import { parsePreviewTarget } from "../shared/preview-target"

const RESOURCE_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".wasm": "application/wasm",
  ".eot": "application/vnd.ms-fontobject", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".webmanifest": "application/manifest+json",
}
export const FILE_PREVIEW_PROTOCOL = 1
export class FileAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
export function filePreviewHeaders(type: string, parent: string) {
  return new Headers({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": filePreviewCsp(parent),
  })
}

function navigationBridge(parent: string) {
  const origin = JSON.stringify(parent).replaceAll("<", "\\u003c")
  return `<script data-stillon-file-navigation>(()=>{
    const parentOrigin=${origin};
    const dependency=label=>parent.postMessage({type:'stillon:file-dependency-error',label},parentOrigin);
    addEventListener('error',event=>{
      const target=event.target;
      if(target instanceof Element&&['SCRIPT','LINK','IMG','VIDEO','AUDIO','SOURCE'].includes(target.tagName)){
        try{dependency(new URL(target.src||target.href,location.href).pathname)}catch{dependency('local resource')}
      }
    },true);
    addEventListener('securitypolicyviolation',event=>dependency('resource blocked by '+event.effectiveDirective));
    const report=()=>parent.postMessage({type:'stillon:file-navigation',path:location.pathname,query:location.search,fragment:location.hash},parentOrigin);
    addEventListener('hashchange',report);addEventListener('popstate',report);
    for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const result=original.apply(this,args);report();return result}}
    const follow=event=>{
      if(event.defaultPrevented||event.altKey||event.button!==0&&event.button!==1)return;
      const a=event.target instanceof Element?event.target.closest('a[href]'):null;
      if(!a||a.hasAttribute('download')||a.target&&!['_self','_blank'].includes(a.target))return;
      const standalone=event.button===1||event.metaKey||event.ctrlKey||event.shiftKey||a.target==='_blank';
      const url=new URL(a.href,location.href);
      if(url.origin!==location.origin){
        if(['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
          event.preventDefault();parent.postMessage({type:'stillon:file-service-link',address:url.href},parentOrigin);return;
        }
        if(['http:','https:'].includes(url.protocol)){a.target='_blank';a.rel='noopener noreferrer'}return
      }
      if(!standalone&&url.pathname===location.pathname&&url.search===location.search)return;
      event.preventDefault();
      if(!standalone){parent.postMessage({type:'stillon:file-link',path:url.pathname,query:url.search,fragment:url.hash,standalone:false},parentOrigin);return}
      // Chromium does not consistently propagate middle-button activation from
      // a cross-origin frame to its parent. Reserve the tab in this gesture.
      const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();if(popup)popup.close()},30000);
      channel.port1.onmessage=event=>{
        clearTimeout(timer);channel.port1.close();
        try{const target=new URL(event.data.url);if(target.origin!==parentOrigin||!/^\\/preview\\/[\\w-]+$/.test(target.pathname))throw new Error('Invalid preview');if(popup)popup.location.replace(target.href)}
        catch{if(popup)popup.close()}
      };
      parent.postMessage({type:'stillon:file-link',path:url.pathname,query:url.search,fragment:url.hash,standalone:true,popupBlocked:!popup},parentOrigin,[channel.port2]);
    };window.addEventListener('click',follow);window.addEventListener('auxclick',follow);addEventListener('DOMContentLoaded',report);
  })()</script>`
}

export class PreviewFiles {
  private local?: ReturnType<typeof Bun.serve>
  private readonly grants = new Map<string, { root: string; owner: string; valid: () => boolean; parent: string; expires: number }>()
  constructor(private readonly projectRoot: (id: string) => string | undefined) {}
  directory(target: PreviewTarget, file: string) { return "resourceRoot" in target && target.resourceRoot ? target.resourceRoot : path.dirname(file) }
  entryPath(target: PreviewTarget, file: string) { return "/" + path.relative(this.directory(target, file), file).split(path.sep).map(encodeURIComponent).join("/") }
  scopeKey(file: string, root = path.dirname(file)) { return createHash("sha256").update(root).digest("hex") }
  async linkedAddress(rootTarget: PreviewTarget, address: string, projectId?: string) {
    const root = await this.resolve(rootTarget)
    if (fileRenderer(root) !== "html") throw new FileAccessError("Only HTML documents authorize file navigation.", 403)
    const next = parsePreviewTarget(address, projectId)
    if (!next || !("filePath" in next)) throw new FileAccessError("This is not a file link.", 400)
    const file = await this.resolve(next)
    const directory = this.directory(rootTarget, root)
    if (!isWithinPreviewDirectory(directory, file)) throw new FileAccessError("Link is outside the authorized HTML directory.", 403)
    return { address, directory }
  }

  async resolve(target: PreviewTarget, allowDirectory = false) {
    if (!("filePath" in target) || !target.filePath) throw new Error("This target is not a file.")
    const rootPath = target.kind === "project-file" ? this.projectRoot(target.projectId) : undefined
    if (target.kind === "project-file" && !rootPath) throw new Error("Workspace unavailable.")
    const candidate = rootPath ? path.resolve(rootPath, target.filePath) : resolveLocalPath(target.filePath)
    const file = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      throw new FileAccessError(error.code === "ENOENT" ? "File was not found." : "File access was denied.", error.code === "ENOENT" ? 404 : 403)
    })
    if (path.extname(candidate).toLowerCase() !== path.extname(file).toLowerCase()) throw new FileAccessError("File type differs from the linked path. Open its real file path.", 415)
    if (rootPath && !isWithinPreviewDirectory(await realpath(rootPath), file)) throw new Error("File is outside the workspace.")
    if (target.canonicalPath && target.canonicalPath !== file) throw new Error("File authorization changed. Open the original link again.")
    if (target.resourceRoot) {
      const root = await realpath(target.resourceRoot)
      if (root !== target.resourceRoot || !isWithinPreviewDirectory(root, file)
        || rootPath && !isWithinPreviewDirectory(await realpath(rootPath), root)) throw new FileAccessError("HTML resource directory authorization changed.", 403)
    }
    const info = await stat(file)
    if (!info.isFile() && !(allowDirectory && info.isDirectory())) throw new FileAccessError("Target must be a file.", 400)
    return file
  }
  async authorize(target: PreviewTarget) {
    if (target.kind === "host-http" && [...protectedPreviewPorts()].includes(Number(new URL(target.address).port || (target.address.startsWith("https:") ? 443 : 80)))) throw new Error("StillOn control ports cannot be used as preview services.")
    if ("filePath" in target) {
      target.canonicalPath = await this.resolve(target, true)
      if (target.kind !== "host-html") target.directory = (await stat(target.canonicalPath)).isDirectory()
      if (target.kind === "host-file") target.filePath = target.canonicalPath
    }
  }
  async content(request: Request, target: PreviewTarget, download: boolean) {
    try {
      const file = await this.resolve(target), info = await stat(file), renderer = fileRenderer(file)
      if (!download && !renderer) return Response.json({ error: "This file has no preview renderer." }, { status: 415 })
      if (!download && info.size > FILE_PREVIEW_MAX_BYTES) return Response.json({ error: "Preview exceeds the 25 MB limit. Download the original file." }, { status: 413 })
      const type = !download && (renderer === "text" || renderer === "markdown") ? "text/plain; charset=utf-8" : imageContentType(file) ?? RESOURCE_TYPES[path.extname(file).toLowerCase()] ?? inferProjectFileContentType(file, Bun.file(file).type)
      const headers = new Headers({ "Content-Type": type, "Content-Length": String(info.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      if (download) headers.set("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replace(/['()*]/gu, c => '%' + c.charCodeAt(0).toString(16))}`)
      // Content endpoints never execute active documents on the application origin.
      headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
      return new Response(request.method === "HEAD" ? null : Bun.file(file), { headers })
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: error instanceof FileAccessError ? error.status : 403 }) }
  }
  async action(target: PreviewTarget, action: string) {
    if (!["open_default", "open_finder"].includes(action)) throw new Error("Invalid host action.")
    if (target.kind === "host-http" && action === "open_default") {
      await spawnDetached(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open", [target.address])
    } else {
      const file = await this.resolve(target, true)
      await openExternal({ type: "system.openExternal", localPath: file, action: action as "open_default" | "open_finder" })
    }
  }
  clear() { this.grants.clear() }
  async close() {
    this.clear()
    if (this.local) { releasePreviewPort(this.local.port!); await this.local.stop(true); this.local = undefined }
  }
  async localEntry(target: PreviewTarget, owner: string, parent: string, valid: () => boolean) {
    const file = await this.resolve(target)
    if (fileRenderer(file) !== "html") throw new Error("An HTML document is required.")
    if (!this.local) {
      this.local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
        const url = new URL(request.url), token = /^f-([a-f0-9]{48})\.localhost$/u.exec(url.hostname)?.[1]
        const grant = token ? this.grants.get(token) : undefined
        if (!grant || grant.expires <= Date.now() || !grant.valid()) return new Response("File preview expired. Reopen it from StillOn.", { status: 410 })
        if (request.headers.get("host") !== url.host) return new Response("Forbidden", { status: 403 })
        return this.resource(request, grant.root, url.pathname, grant.parent)
      } })
      protectPreviewPort(this.local.port!)
    }
    for (const [key, grant] of this.grants) if (grant.expires <= Date.now() || !grant.valid()) this.grants.delete(key)
    const root = this.directory(target, file)
    let token = [...this.grants].find(([, g]) => g.root === root && g.owner === owner && g.parent === parent && g.valid())?.[0]
    if (!token) {
      if (this.grants.size >= 128) throw new Error("File preview grant limit reached. Older grants expire after one hour.")
      token = randomBytes(24).toString("hex")
      this.grants.set(token, { root, owner, valid, parent, expires: Date.now() + 60 * 60_000 })
    }
    const location = new URL(target.address, parent)
    return `http://f-${token}.localhost:${this.local.port}${this.entryPath(target, file)}${location.search}${location.hash}`
  }
  async resource(request: Request, root: string, pathname: string, parent: string) {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("File previews are read only.", { status: 405 })
    if (request.headers.get("sec-fetch-dest") === "serviceworker" || request.headers.get("service-worker")) return new Response("Service workers are unavailable in file previews.", { status: 403 })
    try {
      const relative = pathname.split("/").filter(Boolean).map(decodeURIComponent)
      if (!relative.length || relative.some(p => p === "." || p === ".." || p.startsWith(".") || /[\\/:\u0000-\u001f]/u.test(p))) throw new Error("Resource path is outside the authorized directory.")
      const file = await realpath(path.join(root, ...relative))
      if (!isWithinPreviewDirectory(root, file)) throw new Error("Resource is outside the authorized directory.")
      const extension = path.extname(file).toLowerCase()
      const type = RESOURCE_TYPES[extension] ?? imageContentType(file)
      if (!type) return new Response("Unsupported file resource type.", { status: 415 })
      const info = await stat(file)
      if (!info.isFile()) return new Response("File not found.", { status: 404 })
      if (info.size > FILE_PREVIEW_MAX_BYTES) return new Response("Resource exceeds the 25 MB preview limit.", { status: 413 })
      const headers = filePreviewHeaders(type, parent)
      let body: BodyInit | null = request.method === "HEAD" ? null : Bun.file(file)
      if (request.method !== "HEAD" && type.startsWith("text/html")) {
        const text = await Bun.file(file).text()
        const bridge = navigationBridge(parent)
        body = /<head\b[^>]*>/iu.test(text) ? text.replace(/<head\b[^>]*>/iu, match => match + bridge)
          : /^(\uFEFF?\s*<!doctype[^>]*>)/iu.test(text) ? text.replace(/^(\uFEFF?\s*<!doctype[^>]*>)/iu, match => match + bridge) : bridge + text
      }
      return new Response(body, { headers })
    } catch { return new Response("File resource is unavailable or outside its authorized directory.", { status: 403 }) }
  }
}
