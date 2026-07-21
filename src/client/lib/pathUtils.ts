/**
 * Path utilities for stripping workspace prefixes in display.
 * Supports both local paths (from localPath) and sandbox paths (/home/user/workspace).
 */

import { normalizeLocalFilePath } from "../../shared/local-file-urls"

export interface ParsedLocalFileLink {
  path: string
  line?: number
  column?: number
  query?: string
  fragment?: string
}

const HTML_PREVIEW_EXTENSIONS = new Set([".html", ".htm"])
const MARKDOWN_PREVIEW_EXTENSIONS = new Set([".md", ".markdown", ".mdown"])

export interface ProjectRenderablePreviewPath {
  kind: "html" | "markdown"
  path: string
}

const EDITOR_OPEN_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".diff", ".env", ".go", ".graphql", ".h",
  ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".log", ".lua",
  ".md", ".mjs", ".patch", ".php", ".pl", ".properties", ".py", ".rb", ".rs", ".scss", ".sh",
  ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
])

const EDITOR_OPEN_FILENAMES = new Set([
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "Dockerfile",
  "Gemfile",
  "Makefile",
  "Procfile",
])

interface ParsedFileTarget {
  path: string
  line?: number
  column?: number
  query?: string
  fragment?: string
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/i
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+[\\/][^\\/]+/

function toPositiveInteger(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function safeDecodePath(path: string) {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function stripTrailingSlashes(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

function withTargetLocation(
  target: ParsedFileTarget,
  location: { query?: string; fragment?: string },
): ParsedFileTarget {
  return {
    ...target,
    ...(location.query ? { query: location.query } : {}),
    ...(location.fragment ? { fragment: location.fragment } : {}),
  }
}

function splitTargetLocation(target: string) {
  const hashIndex = target.indexOf("#")
  const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined
  const withoutFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target
  const queryIndex = withoutFragment.indexOf("?")
  return {
    path: queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment,
    query: queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : undefined,
    fragment,
  }
}

function getFileExtension(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? path
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
}

function isHtmlFilePath(path: string) {
  return HTML_PREVIEW_EXTENSIONS.has(getFileExtension(path))
}

function isMarkdownFilePath(path: string) {
  return MARKDOWN_PREVIEW_EXTENSIONS.has(getFileExtension(path))
}

function getRenderablePreviewKind(path: string): ProjectRenderablePreviewPath["kind"] | null {
  if (isHtmlFilePath(path)) return "html"
  if (isMarkdownFilePath(path)) return "markdown"
  return null
}

function normalizeProjectRelativePath(path: string) {
  const normalizedParts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (normalizedParts.length === 0) return null
      normalizedParts.pop()
      continue
    }
    normalizedParts.push(part)
  }
  return normalizedParts.join("/")
}

function parseAbsoluteFileTarget(target: string): ParsedFileTarget | null {
  const location = splitTargetLocation(target)
  if (!location.path.startsWith("/")) return null

  const lineFragmentMatch = /^L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(location.fragment ?? "")
  if (lineFragmentMatch?.groups?.line) {
    return withTargetLocation({
      path: safeDecodePath(location.path),
      line: toPositiveInteger(lineFragmentMatch.groups.line),
      column: toPositiveInteger(lineFragmentMatch.groups.column),
    }, { query: location.query })
  }

  const suffixMatch = /^(?<path>\/.+?):(?<line>\d+)(?::(?<column>\d+))?$/.exec(location.path)
  if (suffixMatch?.groups?.path) {
    return withTargetLocation({
      path: safeDecodePath(suffixMatch.groups.path),
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }, location)
  }

  return withTargetLocation({ path: safeDecodePath(location.path) }, location)
}

function parseWindowsAbsoluteFileTarget(target: string): ParsedFileTarget | null {
  if (!WINDOWS_ABSOLUTE_PATH_PATTERN.test(target) && !WINDOWS_UNC_PATH_PATTERN.test(target)) return null

  const location = splitTargetLocation(target)
  const normalizedPath = location.path.replace(/\\/g, "/")
  const lineFragmentMatch = /^L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(location.fragment ?? "")
  if (lineFragmentMatch?.groups?.line) {
    return withTargetLocation({
      path: safeDecodePath(normalizedPath),
      line: toPositiveInteger(lineFragmentMatch.groups.line),
      column: toPositiveInteger(lineFragmentMatch.groups.column),
    }, { query: location.query })
  }

  const suffixMatch = /^(?<path>(?:[a-z]:\/|\/\/).+?):(?<line>\d+)(?::(?<column>\d+))?$/i.exec(normalizedPath)
  if (suffixMatch?.groups?.path) {
    return withTargetLocation({
      path: safeDecodePath(suffixMatch.groups.path),
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }, location)
  }

  return withTargetLocation({ path: safeDecodePath(normalizedPath) }, location)
}

function parseRelativeFileTarget(target: string): ParsedFileTarget | null {
  const isLineSuffix = /^(?:[^/?#]*[./\\][^?#]*):\d+(?::\d+)?(?:[?#]|$)/.test(target)
  if (
    target.startsWith("/")
    || target.startsWith("#")
    || target.startsWith("?")
    || target.startsWith("//")
    || (/^[a-z][a-z\d+.-]*:/i.test(target) && !isLineSuffix)
  ) {
    return null
  }

  const location = splitTargetLocation(target)
  if (!location.path) return null

  const lineFragmentMatch = /^L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(location.fragment ?? "")
  if (lineFragmentMatch?.groups?.line) {
    return withTargetLocation({
      path: safeDecodePath(location.path),
      line: toPositiveInteger(lineFragmentMatch.groups.line),
      column: toPositiveInteger(lineFragmentMatch.groups.column),
    }, { query: location.query })
  }

  const suffixMatch = /^(?<path>.+?):(?<line>\d+)(?::(?<column>\d+))?$/.exec(location.path)
  if (suffixMatch?.groups?.path) {
    return withTargetLocation({
      path: safeDecodePath(suffixMatch.groups.path),
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }, location)
  }

  return withTargetLocation({ path: safeDecodePath(location.path) }, location)
}

export function parseLocalFileLink(target: string | undefined | null): ParsedLocalFileLink | null {
  if (!target) return null
  const normalizedTarget = normalizeLocalFilePath(target.trim())
  if (!normalizedTarget || /^(mailto:|ftp:|file:)/i.test(normalizedTarget)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(normalizedTarget) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedTarget)) return null

  return parseWindowsAbsoluteFileTarget(normalizedTarget) ?? parseAbsoluteFileTarget(normalizedTarget)
}

export function getProjectRelativeFilePath(filePath: string | undefined | null, localPath: string | undefined | null) {
  if (!filePath || !localPath) return null
  const decodedFilePath = normalizeLocalFilePath(safeDecodePath(filePath)).replace(/\\/g, "/")
  const projectPath = stripTrailingSlashes(normalizeLocalFilePath(safeDecodePath(localPath)).replace(/\\/g, "/"))
  const projectPrefix = `${projectPath}/`
  const caseInsensitive = WINDOWS_ABSOLUTE_PATH_PATTERN.test(decodedFilePath)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(projectPath)
    || decodedFilePath.startsWith("//")
    || projectPath.startsWith("//")
  const comparedFilePath = caseInsensitive ? decodedFilePath.toLowerCase() : decodedFilePath
  const comparedProjectPrefix = caseInsensitive ? projectPrefix.toLowerCase() : projectPrefix
  if (!comparedFilePath.startsWith(comparedProjectPrefix)) return null

  const relativePath = normalizeProjectRelativePath(decodedFilePath.slice(projectPrefix.length))
  return relativePath || null
}

export function getProjectRenderablePreviewPath(filePath: string | undefined | null, localPath: string | undefined | null): ProjectRenderablePreviewPath | null {
  const relativePath = getProjectRelativeFilePath(filePath, localPath)
  if (!relativePath) return null

  const kind = getRenderablePreviewKind(relativePath)
  return kind ? { kind, path: relativePath } : null
}

export function getProjectHtmlPreviewPath(filePath: string | undefined | null, localPath: string | undefined | null) {
  const preview = getProjectRenderablePreviewPath(filePath, localPath)
  return preview?.kind === "html" ? preview.path : null
}

export function parseProjectRelativeRenderableFileLink(target: string | undefined | null, localPath: string | undefined | null): ParsedLocalFileLink | null {
  const parsed = parseProjectRelativeFileLink(target, localPath)
  return parsed && getRenderablePreviewKind(parsed.path) ? parsed : null
}

export function parseProjectRelativeFileLink(target: string | undefined | null, localPath: string | undefined | null): ParsedLocalFileLink | null {
  if (!target || !localPath) return null
  const parsedTarget = parseRelativeFileTarget(target.trim())
  if (!parsedTarget) return null

  const relativePath = normalizeProjectRelativePath(safeDecodePath(parsedTarget.path))
  if (!relativePath) return null

  const projectPath = stripTrailingSlashes(normalizeLocalFilePath(safeDecodePath(localPath)).replace(/\\/g, "/"))
  return {
    ...parsedTarget,
    path: `${projectPath}/${relativePath}`,
  }
}

export function parseProjectRelativeHtmlFileLink(target: string | undefined | null, localPath: string | undefined | null): ParsedLocalFileLink | null {
  const parsed = parseProjectRelativeRenderableFileLink(target, localPath)
  if (!parsed) return null
  return isHtmlFilePath(parsed.path) ? parsed : null
}

export function shouldOpenLocalFileLinkInEditor(filePath: string) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  if (EDITOR_OPEN_FILENAMES.has(fileName)) return true
  const extensionIndex = fileName.lastIndexOf(".")
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
  return EDITOR_OPEN_EXTENSIONS.has(extension)
}

export function appendLocalFileLinkLocation(url: string, target: Pick<ParsedLocalFileLink, "query" | "fragment">) {
  const withQuery = target.query ? `${url}?${target.query}` : url
  return target.fragment ? `${withQuery}#${target.fragment}` : withQuery
}


/**
 * Strip workspace prefix for display.
 * e.g., "/home/user/workspace/src/foo.ts" → "src/foo.ts"
 * e.g., "/Users/example/Projects/sample-app/src/foo.ts" → "src/foo.ts" (when localPath is set)
 */
export function stripWorkspacePath(path: string | undefined, localPath: string | undefined | null): string {
  if (!path) return ""
  // Try localPath first (with or without trailing slash)
  if (localPath) {
    const withSlash = localPath.endsWith("/") ? localPath : `${localPath}/`
    if (path.startsWith(withSlash)) return path.slice(withSlash.length)
    if (path === localPath) return ""
  }
  // Fallback to sandbox path
  return path.replace(/^\/home\/user\/workspace\//, "")
}

/**
 * Strip outputs prefix for API paths.
 * e.g., "/home/user/workspace/outputs/foo/bar.csv" → "/foo/bar.csv"
 */
export function stripOutputsPath(path: string | undefined, localPath: string | undefined | null): string | undefined {
  if (!path) return undefined
  if (localPath) {
    const outputsPrefix = `${localPath}/outputs`
    if (path.startsWith(outputsPrefix)) return path.slice(outputsPrefix.length)
  }
  return path.replace(/^\/home\/user\/workspace\/outputs/, "") || undefined
}
