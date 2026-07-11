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

export interface ProjectMarkdownPreviewTarget {
  projectId: string
  filePath: string
}

export function parseProjectMarkdownPreviewUrl(address: string): ProjectMarkdownPreviewTarget | null {
  if (!address.startsWith("/")) return null
  const match = address.match(/^\/api\/projects\/([^/]+)\/markdown-preview\/(.+)$/)
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
