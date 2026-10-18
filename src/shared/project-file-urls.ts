export function buildProjectFileContentUrl(projectId: string, filePath: string, options: { download?: boolean } = {}) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filePath)}/content`
  return options.download ? `${url}?download=1` : url
}

export function buildProjectFilePreviewUrl(projectId: string, filePath: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/preview/${encodeProjectPreviewPath(filePath)}`
}

export function buildProjectMarkdownPreviewUrl(projectId: string, filePath: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/markdown-preview/${encodeProjectPreviewPath(filePath)}`
}

export function buildProjectRenderablePreviewUrl(projectId: string, filePath: string) {
  return isProjectMarkdownPreviewPath(filePath)
    ? buildProjectMarkdownPreviewUrl(projectId, filePath)
    : buildProjectFilePreviewUrl(projectId, filePath)
}

/** Keep saved host-local preview links on the currently connected computer. */
export function normalizeProjectPreviewAddress(address: string, projectId: string, currentOrigin: string) {
  let url: URL
  try { url = new URL(address) } catch { return address }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return address
  let current: URL
  try { current = new URL(currentOrigin) } catch { return address }
  if (url.origin !== current.origin) {
    const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"]
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    const currentPort = current.port || (current.protocol === "https:" ? "443" : "80")
    // Only migrate known StillOn origins. An app can pushState to a path that
    // looks like a file preview; its origin must never become a file grant.
    if (!loopbackHosts.includes(url.hostname)
      || (port !== "3210" && !(loopbackHosts.includes(current.hostname) && port === currentPort))) return address
  }
  const match = /^\/api\/projects\/([^/]+)\/(?:preview|markdown-preview)\//u.exec(url.pathname)
  try { if (!match || decodeURIComponent(match[1]!) !== projectId) return address } catch { return address }
  return url.pathname + url.search + url.hash
}

export interface ProjectMarkdownPreviewTarget {
  projectId: string
  filePath: string
}

export function parseProjectFilePreviewUrl(address: string): ProjectMarkdownPreviewTarget | null {
  if (!address.startsWith("/")) return null
  try {
    const match = new URL(address, "http://stillon.invalid").pathname.match(/^\/api\/projects\/([^/]+)\/preview\/(.+)$/u)
    if (!match) return null
    const projectId = decodeURIComponent(match[1]!)
    const filePath = decodeProjectPreviewPath(match[2]!).replaceAll("\\", "/")
    if (!projectId || !filePath || filePath.startsWith("/") || /^[a-z]:/iu.test(filePath)
      || filePath.includes("\0") || filePath.split("/").some(part => part === "..")) return null
    return { projectId, filePath }
  } catch { return null }
}

export function parseProjectMarkdownPreviewUrl(address: string): ProjectMarkdownPreviewTarget | null {
  if (!address.startsWith("/")) return null
  let pathname: string
  try {
    pathname = new URL(address, "http://stillon.invalid").pathname
  } catch {
    return null
  }
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/markdown-preview\/(.+)$/)
  if (!match) return null

  try {
    const projectId = decodeURIComponent(match[1] ?? "")
    const filePath = decodeProjectPreviewPath(match[2] ?? "")
    if (!projectId || !filePath || !isProjectMarkdownPreviewPath(filePath)) return null
    return { projectId, filePath }
  } catch {
    return null
  }
}

export function isProjectMarkdownPreviewPath(filePath: string) {
  const extension = getProjectFileExtension(filePath)
  return extension === ".md" || extension === ".markdown" || extension === ".mdown"
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".diff", ".env", ".go", ".graphql", ".h",
  ".hpp", ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".log", ".lua", ".mjs",
  ".patch", ".php", ".pl", ".properties", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zsh",
])
const TEXT_PREVIEW_FILENAMES = new Set([".gitignore", ".npmrc", ".prettierrc", "Dockerfile", "Makefile", "Gemfile", "Procfile"])

export function isProjectTextPreviewPath(filePath: string) {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  return TEXT_PREVIEW_EXTENSIONS.has(getProjectFileExtension(filePath)) || TEXT_PREVIEW_FILENAMES.has(name)
}

function getProjectFileExtension(filePath: string) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
}

export function encodeProjectPreviewPath(filePath: string) {
  return filePath
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/")
}

function decodeProjectPreviewPath(filePath: string) {
  return filePath
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodeURIComponent)
    .join("/")
}
