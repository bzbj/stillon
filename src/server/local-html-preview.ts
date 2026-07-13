import { randomBytes } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { LOCAL_HTML_PREVIEW_SESSION_ENDPOINT } from "../shared/local-file-urls"
import { inferProjectFileContentType } from "./uploads"

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000
const MAX_SESSIONS = 64
const MAX_FILE_PATH_LENGTH = 16 * 1024

const ALLOWED_PREVIEW_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".cjs",
  ".css",
  ".eot",
  ".gif",
  ".htm",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".m4a",
  ".mjs",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
])

const LOCAL_HTML_PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "sandbox allow-scripts",
].join("; ")

const SAFE_SVG_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "style-src 'unsafe-inline'",
  "sandbox",
].join("; ")

interface LocalHtmlPreviewSession {
  rootPath: string
  expiresAt: number
}

export interface LocalHtmlPreviewManagerOptions {
  ttlMs?: number
  now?: () => number
  createToken?: () => string
}

export interface LocalHtmlPreviewRequestOptions {
  allowCreate: boolean
}

export interface LocalHtmlPreviewManager {
  handleRequest: (
    req: Request,
    url: URL,
    options: LocalHtmlPreviewRequestOptions,
  ) => Promise<Response | null>
  dispose: () => void
}

export function isLoopbackBindHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

export function createLocalHtmlPreviewManager(
  options: LocalHtmlPreviewManagerOptions = {},
): LocalHtmlPreviewManager {
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
  const now = options.now ?? Date.now
  const createToken = options.createToken ?? (() => randomBytes(24).toString("base64url"))
  const sessions = new Map<string, LocalHtmlPreviewSession>()

  function pruneSessions() {
    const currentTime = now()
    for (const [token, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(token)
      }
    }

    while (sessions.size >= MAX_SESSIONS) {
      const oldestToken = sessions.keys().next().value
      if (typeof oldestToken !== "string") break
      sessions.delete(oldestToken)
    }
  }

  async function createSession(req: Request, allowCreate: boolean) {
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } })
    }

    if (!allowCreate) {
      return Response.json(
        { error: "Project-external HTML previews require password protection unless StillOn only listens on loopback." },
        { status: 403 },
      )
    }

    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return Response.json({ error: "Invalid preview request." }, { status: 400 })
    }

    const filePath = payload && typeof payload === "object" && "filePath" in payload
      ? (payload as { filePath?: unknown }).filePath
      : null
    if (
      typeof filePath !== "string"
      || filePath.length === 0
      || filePath.length > MAX_FILE_PATH_LENGTH
      || filePath.includes("\0")
      || !path.isAbsolute(filePath)
      || !isHtmlFile(filePath)
    ) {
      return Response.json({ error: "Preview path must be an absolute HTML file path." }, { status: 400 })
    }

    let canonicalFilePath: string
    let fileInfo
    try {
      canonicalFilePath = await realpath(filePath)
      fileInfo = await stat(canonicalFilePath)
    } catch {
      return Response.json({ error: "HTML preview file was not found." }, { status: 404 })
    }

    if (!fileInfo.isFile() || !isHtmlFile(canonicalFilePath)) {
      return Response.json({ error: "Preview path must resolve to an HTML file." }, { status: 400 })
    }

    pruneSessions()
    let token = createToken()
    while (!token || sessions.has(token) || !/^[A-Za-z0-9_-]+$/.test(token)) {
      token = createToken()
    }

    const expiresAt = now() + ttlMs
    sessions.set(token, {
      rootPath: path.dirname(canonicalFilePath),
      expiresAt,
    })

    const entryPath = encodePathSegments(path.basename(canonicalFilePath))
    const response = Response.json({
      url: `${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}/${token}/${entryPath}`,
      expiresAt,
    }, { status: 201 })
    response.headers.set("Cache-Control", "no-store")
    return response
  }

  async function serveSessionFile(req: Request, token: string, rawRelativePath: string) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
    }

    const session = sessions.get(token)
    if (!session) {
      return Response.json({ error: "Local HTML preview session was not found." }, { status: 404 })
    }
    if (session.expiresAt <= now()) {
      sessions.delete(token)
      return Response.json({ error: "Local HTML preview session expired. Open the file again to refresh it." }, { status: 410 })
    }

    const relativePath = decodeRelativePath(rawRelativePath)
    if (!relativePath) {
      return Response.json({ error: "Invalid local HTML preview path." }, { status: 400 })
    }

    const candidatePath = path.resolve(session.rootPath, ...relativePath.split("/"))
    let canonicalFilePath: string
    let fileInfo
    try {
      canonicalFilePath = await realpath(candidatePath)
      fileInfo = await stat(canonicalFilePath)
    } catch {
      return Response.json({ error: "Local HTML preview resource was not found." }, { status: 404 })
    }

    if (!isPathInsideRoot(session.rootPath, canonicalFilePath)) {
      return Response.json({ error: "Local HTML preview path escapes its authorized directory." }, { status: 403 })
    }
    if (!fileInfo.isFile()) {
      return Response.json({ error: "Local HTML preview resource was not found." }, { status: 404 })
    }

    const extension = path.extname(canonicalFilePath).toLowerCase()
    if (!ALLOWED_PREVIEW_EXTENSIONS.has(extension)) {
      return Response.json({ error: "This file type is not available to local HTML previews." }, { status: 403 })
    }

    const file = Bun.file(canonicalFilePath)
    const headers = getPreviewHeaders(canonicalFilePath, file.type)
    return new Response(req.method === "HEAD" ? null : file, { headers })
  }

  return {
    async handleRequest(req, url, requestOptions) {
      if (url.pathname === LOCAL_HTML_PREVIEW_SESSION_ENDPOINT) {
        return createSession(req, requestOptions.allowCreate)
      }

      const match = url.pathname.match(/^\/api\/local-html-previews\/([A-Za-z0-9_-]+)\/(.+)$/)
      if (!match) return null
      return serveSessionFile(req, match[1]!, match[2]!)
    },
    dispose() {
      sessions.clear()
    },
  }
}

function decodeRelativePath(rawPath: string) {
  let decodedPath: string
  try {
    decodedPath = rawPath
      .split("/")
      .map(decodeURIComponent)
      .join("/")
      .replaceAll("\\", "/")
  } catch {
    return null
  }

  if (!decodedPath || decodedPath.includes("\0") || path.posix.isAbsolute(decodedPath)) {
    return null
  }

  const normalizedPath = path.posix.normalize(decodedPath)
  if (
    !normalizedPath
    || normalizedPath === "."
    || normalizedPath === ".."
    || normalizedPath.startsWith("../")
    || normalizedPath.includes("/../")
  ) {
    return null
  }
  return normalizedPath
}

function encodePathSegments(relativePath: string) {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")
}

function isPathInsideRoot(rootPath: string, filePath: string) {
  const relativePath = path.relative(rootPath, filePath)
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
}

function isHtmlFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  return extension === ".html" || extension === ".htm"
}

function getPreviewHeaders(filePath: string, fallbackType?: string) {
  const extension = path.extname(filePath).toLowerCase()
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": inferPreviewContentType(filePath, fallbackType),
    "Permissions-Policy": "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })

  if (extension === ".html" || extension === ".htm") {
    headers.set("Content-Security-Policy", LOCAL_HTML_PREVIEW_CSP)
    headers.set("X-Frame-Options", "SAMEORIGIN")
  } else if (extension === ".svg") {
    headers.set("Content-Security-Policy", SAFE_SVG_CSP)
  }

  return headers
}

function inferPreviewContentType(filePath: string, fallbackType?: string) {
  const extension = path.extname(filePath).toLowerCase()
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".wasm":
      return "application/wasm"
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8"
    default:
      return inferProjectFileContentType(filePath, fallbackType)
  }
}
