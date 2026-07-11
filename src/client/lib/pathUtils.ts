/**
 * Path utilities for stripping workspace prefixes in display.
 * Supports both local paths (from localPath) and sandbox paths (/home/user/workspace).
 */

export interface ParsedLocalFileLink {
  path: string
  line?: number
  column?: number
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
}

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
  const hashMatch = /^(?<path>\/.+?)#L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(target)
  if (hashMatch?.groups?.path) {
    return {
      path: hashMatch.groups.path,
      line: toPositiveInteger(hashMatch.groups.line),
      column: toPositiveInteger(hashMatch.groups.column),
    }
  }

  const suffixMatch = /^(?<path>\/.+?):(?<line>\d+)(?::(?<column>\d+))?$/.exec(target)
  if (suffixMatch?.groups?.path) {
    return {
      path: suffixMatch.groups.path,
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }
  }

  if (target.startsWith("/")) {
    return { path: target }
  }

  return null
}

function parseRelativeFileTarget(target: string): ParsedFileTarget | null {
  if (
    target.startsWith("/")
    || target.startsWith("#")
    || target.startsWith("?")
    || target.startsWith("//")
    || /^[a-z][a-z\d+.-]*:/i.test(target)
  ) {
    return null
  }

  const hashMatch = /^(?<path>[^?#]+?)#L(?<line>\d+)(?:C(?<column>\d+))?$/.exec(target)
  if (hashMatch?.groups?.path) {
    return {
      path: hashMatch.groups.path,
      line: toPositiveInteger(hashMatch.groups.line),
      column: toPositiveInteger(hashMatch.groups.column),
    }
  }

  const suffixMatch = /^(?<path>[^?#]+?):(?<line>\d+)(?::(?<column>\d+))?$/.exec(target)
  if (suffixMatch?.groups?.path) {
    return {
      path: suffixMatch.groups.path,
      line: toPositiveInteger(suffixMatch.groups.line),
      column: toPositiveInteger(suffixMatch.groups.column),
    }
  }

  if (target.includes("?") || !target.includes(".")) {
    return null
  }

  return { path: target }
}

export function parseLocalFileLink(target: string | undefined | null): ParsedLocalFileLink | null {
  if (!target) return null
  const trimmed = target.trim()
  if (!trimmed || /^(mailto:|ftp:|file:)/i.test(trimmed)) return null

  if (/^https?:/i.test(trimmed)) {
    if (typeof window === "undefined") {
      return null
    }
    try {
      const url = new URL(trimmed)
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/")) {
        return null
      }
      return parseAbsoluteFileTarget(`${url.pathname}${url.hash}`)
    } catch {
      return null
    }
  }

  return parseAbsoluteFileTarget(trimmed)
}

export function getProjectRenderablePreviewPath(filePath: string | undefined | null, localPath: string | undefined | null): ProjectRenderablePreviewPath | null {
  if (!filePath || !localPath) return null
  const decodedFilePath = safeDecodePath(filePath).replace(/\\/g, "/")
  const projectPath = stripTrailingSlashes(safeDecodePath(localPath).replace(/\\/g, "/"))
  const projectPrefix = `${projectPath}/`
  if (!decodedFilePath.startsWith(projectPrefix)) return null

  const relativePath = normalizeProjectRelativePath(decodedFilePath.slice(projectPrefix.length))
  if (!relativePath) return null

  const kind = getRenderablePreviewKind(relativePath)
  return kind ? { kind, path: relativePath } : null
}

export function getProjectHtmlPreviewPath(filePath: string | undefined | null, localPath: string | undefined | null) {
  const preview = getProjectRenderablePreviewPath(filePath, localPath)
  return preview?.kind === "html" ? preview.path : null
}

export function parseProjectRelativeRenderableFileLink(target: string | undefined | null, localPath: string | undefined | null): ParsedLocalFileLink | null {
  if (!target || !localPath) return null
  const parsedTarget = parseRelativeFileTarget(target.trim())
  if (!parsedTarget) return null

  const relativePath = normalizeProjectRelativePath(safeDecodePath(parsedTarget.path))
  if (!relativePath || !getRenderablePreviewKind(relativePath)) return null

  const projectPath = stripTrailingSlashes(safeDecodePath(localPath).replace(/\\/g, "/"))
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
