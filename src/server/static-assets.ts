import type { Stats } from "node:fs"
import { lstat } from "node:fs/promises"
import path from "node:path"
import { APP_NAME } from "../shared/branding"

export const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
export const REVALIDATE_ASSET_CACHE_CONTROL = "no-cache"

const CONTENT_HASHED_BUILD_ASSET = /^assets\/.+-[a-f0-9]{12}\.[^/]+$/u

type StaticEncoding = "br" | "gzip" | "identity"

interface StaticRepresentation {
  encoding: StaticEncoding
  filePath: string
  metadata: Stats
}

interface ResolvedStaticFile {
  filePath: string
  metadata: Stats
  relativePath: string
}

type ParsedByteRange = {
  end: number
  start: number
} | "unsatisfiable" | null

export function isContentHashedBuildAssetPath(requestedPath: string) {
  const relativePath = requestedPath.replace(/^\/+/u, "").replaceAll("\\", "/")
  return CONTENT_HASHED_BUILD_ASSET.test(relativePath)
}

async function getFileMetadata(filePath: string) {
  try {
    const metadata = await lstat(filePath)
    return metadata.isFile() ? metadata : null
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null
    }
    throw error
  }
}

function resolveStaticRelativePath(distDir: string, pathname: string) {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return null
  }

  const rawSegments = decodedPath.replace(/^\/+/u, "").split("/")
  if (rawSegments.some((segment) => segment === "..")) {
    return null
  }

  const relativePath = path.posix.normalize(rawSegments.join("/"))
  const requestedPath = relativePath === "." || relativePath === ""
    ? "index.html"
    : relativePath
  const rootPath = path.resolve(distDir)
  const filePath = path.resolve(rootPath, ...requestedPath.split("/"))
  const relativeToRoot = path.relative(rootPath, filePath)
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    return null
  }

  return {
    filePath,
    relativePath: requestedPath,
  }
}

function shouldServeSpaFallback(relativePath: string) {
  return relativePath !== "assets"
    && !relativePath.startsWith("assets/")
    && path.posix.extname(relativePath) === ""
}

async function resolveStaticFile(distDir: string, pathname: string): Promise<ResolvedStaticFile | Response> {
  const requested = resolveStaticRelativePath(distDir, pathname)
  if (!requested || requested.relativePath.endsWith(".br") || requested.relativePath.endsWith(".gz")) {
    return notFoundResponse()
  }

  const requestedMetadata = await getFileMetadata(requested.filePath)
  if (requestedMetadata) {
    return {
      ...requested,
      metadata: requestedMetadata,
    }
  }

  if (requested.relativePath === "index.html") {
    return clientBundleMissingResponse()
  }
  if (!shouldServeSpaFallback(requested.relativePath)) {
    return notFoundResponse()
  }

  const indexPath = path.join(path.resolve(distDir), "index.html")
  const indexMetadata = await getFileMetadata(indexPath)
  if (indexMetadata) {
    return {
      filePath: indexPath,
      metadata: indexMetadata,
      relativePath: "index.html",
    }
  }

  return clientBundleMissingResponse()
}

function clientBundleMissingResponse() {
  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` first.`,
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  )
}

function notFoundResponse() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": REVALIDATE_ASSET_CACHE_CONTROL,
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}

function parseQuality(rawValue: string | undefined) {
  if (rawValue === undefined) {
    return 1
  }
  const value = rawValue.trim()
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(value)) {
    return 0
  }
  return Number(value)
}

function parseAcceptEncoding(header: string) {
  const preferences = new Map<string, number>()
  for (const item of header.split(",")) {
    const [rawEncoding, ...rawParameters] = item.trim().split(";")
    const encoding = rawEncoding?.trim().toLowerCase()
    if (!encoding) {
      continue
    }
    const qualityParameter = rawParameters
      .map((parameter) => parameter.trim().split("=", 2))
      .find(([name]) => name?.trim().toLowerCase() === "q")
    const quality = parseQuality(qualityParameter?.[1])
    preferences.set(encoding, Math.max(preferences.get(encoding) ?? 0, quality))
  }
  return preferences
}

function getEncodingQuality(
  encoding: StaticEncoding,
  preferences: ReadonlyMap<string, number>,
) {
  const explicit = preferences.get(encoding)
  if (explicit !== undefined) {
    return explicit
  }
  const wildcard = preferences.get("*")
  if (encoding === "identity") {
    return wildcard === 0 ? 0 : 1
  }
  return wildcard ?? 0
}

function selectStaticRepresentation(
  acceptEncoding: string | null,
  representations: StaticRepresentation[],
) {
  if (acceptEncoding === null || acceptEncoding.trim() === "") {
    return representations.find((representation) => representation.encoding === "identity") ?? null
  }

  const preferences = parseAcceptEncoding(acceptEncoding)
  const priority: Record<StaticEncoding, number> = {
    br: 3,
    gzip: 2,
    identity: 1,
  }
  return representations
    .map((representation) => ({
      quality: getEncodingQuality(representation.encoding, preferences),
      representation,
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => (
      right.quality - left.quality
      || priority[right.representation.encoding] - priority[left.representation.encoding]
    ))[0]?.representation ?? null
}

function getStaticContentType(filePath: string) {
  if (path.extname(filePath).toLowerCase() === ".html") {
    return "text/html; charset=utf-8"
  }
  return Bun.file(filePath).type || "application/octet-stream"
}

function createWeakEtag(metadata: Stats, encoding: StaticEncoding) {
  const modifiedAt = Math.round(metadata.mtimeMs * 1_000)
  return `W/"${metadata.size.toString(16)}-${modifiedAt.toString(16)}-${encoding}"`
}

function normalizeWeakEtag(value: string) {
  return value.trim().replace(/^W\//iu, "")
}

function ifNoneMatchMatches(header: string, etag: string) {
  if (header.trim() === "*") {
    return true
  }
  const normalizedEtag = normalizeWeakEtag(etag)
  return header.split(",").some((candidate) => normalizeWeakEtag(candidate) === normalizedEtag)
}

function isNotModifiedSince(header: string, metadata: Stats) {
  const timestamp = Date.parse(header)
  if (!Number.isFinite(timestamp)) {
    return false
  }
  return Math.floor(metadata.mtimeMs / 1_000) * 1_000 <= timestamp
}

function shouldIgnoreRange(request: Request, etag: string, metadata: Stats) {
  if (request.method !== "GET" || !request.headers.has("Range")) {
    return false
  }
  const ifRange = request.headers.get("If-Range")
  if (!ifRange) {
    return false
  }

  if (ifRange.startsWith("\"") || ifRange.startsWith("W/")) {
    return etag.startsWith("W/") || ifRange !== etag
  }
  const timestamp = Date.parse(ifRange)
  if (!Number.isFinite(timestamp)) {
    return true
  }
  return Math.floor(metadata.mtimeMs / 1_000) * 1_000 > timestamp
}

function parseByteRange(header: string, size: number): ParsedByteRange {
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/iu)
  if (!match) {
    return null
  }

  const rawStart = match[1] ?? ""
  const rawEnd = match[2] ?? ""
  if (!rawStart && !rawEnd) {
    return null
  }
  if (size <= 0) {
    return "unsatisfiable"
  }

  if (!rawStart) {
    const requestedSuffix = Number(rawEnd)
    if (!Number.isSafeInteger(requestedSuffix) || requestedSuffix <= 0) {
      return requestedSuffix > Number.MAX_SAFE_INTEGER
        ? { start: 0, end: size - 1 }
        : "unsatisfiable"
    }
    return {
      start: Math.max(size - requestedSuffix, 0),
      end: size - 1,
    }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return "unsatisfiable"
  }
  if (!rawEnd) {
    return { start, end: size - 1 }
  }

  const requestedEnd = Number(rawEnd)
  if (requestedEnd < start) {
    return "unsatisfiable"
  }
  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  }
}

export async function serveStaticAsset(
  distDir: string,
  request: Request,
  pathname: string,
): Promise<Response> {
  const resolved = await resolveStaticFile(distDir, pathname)
  if (resolved instanceof Response) {
    return resolved
  }

  const [brotliMetadata, gzipMetadata] = await Promise.all([
    getFileMetadata(`${resolved.filePath}.br`),
    getFileMetadata(`${resolved.filePath}.gz`),
  ])
  const representations: StaticRepresentation[] = [
    ...(brotliMetadata ? [{
      encoding: "br" as const,
      filePath: `${resolved.filePath}.br`,
      metadata: brotliMetadata,
    }] : []),
    ...(gzipMetadata ? [{
      encoding: "gzip" as const,
      filePath: `${resolved.filePath}.gz`,
      metadata: gzipMetadata,
    }] : []),
    {
      encoding: "identity",
      filePath: resolved.filePath,
      metadata: resolved.metadata,
    },
  ]
  const representation = selectStaticRepresentation(
    request.headers.get("Accept-Encoding"),
    representations,
  )
  const hasEncodedVariant = Boolean(brotliMetadata || gzipMetadata)
  if (!representation) {
    return new Response(null, {
      status: 406,
      headers: {
        "Cache-Control": REVALIDATE_ASSET_CACHE_CONTROL,
        ...(hasEncodedVariant ? { Vary: "Accept-Encoding" } : {}),
      },
    })
  }

  const etag = createWeakEtag(representation.metadata, representation.encoding)
  const cacheControl = isContentHashedBuildAssetPath(resolved.relativePath)
    ? IMMUTABLE_ASSET_CACHE_CONTROL
    : REVALIDATE_ASSET_CACHE_CONTROL
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Content-Type": getStaticContentType(resolved.filePath),
    ETag: etag,
    "Last-Modified": new Date(representation.metadata.mtimeMs).toUTCString(),
    "X-Content-Type-Options": "nosniff",
  })
  if (hasEncodedVariant) {
    headers.set("Vary", "Accept-Encoding")
  }
  if (representation.encoding !== "identity") {
    headers.set("Content-Encoding", representation.encoding)
  }

  const ifNoneMatch = request.headers.get("If-None-Match")
  if (ifNoneMatch && ifNoneMatchMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: request.method === "GET" || request.method === "HEAD" ? 304 : 412,
      headers,
    })
  }
  if (
    !ifNoneMatch
    && (request.method === "GET" || request.method === "HEAD")
    && request.headers.get("If-Modified-Since")
    && isNotModifiedSince(request.headers.get("If-Modified-Since")!, representation.metadata)
  ) {
    return new Response(null, { status: 304, headers })
  }

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(representation.metadata.size))
    return new Response(null, { headers })
  }

  const file = Bun.file(representation.filePath, {
    type: getStaticContentType(resolved.filePath),
  })
  const rangeHeader = request.method === "GET"
    ? request.headers.get("Range")
    : null
  if (rangeHeader) {
    if (shouldIgnoreRange(request, etag, representation.metadata)) {
      return new Response(await file.bytes(), { headers })
    }

    const range = parseByteRange(rangeHeader, representation.metadata.size)
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${representation.metadata.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      headers.set("Content-Length", String(range.end - range.start + 1))
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${representation.metadata.size}`)
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers,
      })
    }

    // Buffer only malformed or unsupported multi-range requests so Bun
    // versions with automatic range handling do not diverge from older ones.
    return new Response(await file.bytes(), { headers })
  }

  return new Response(file, { headers })
}
