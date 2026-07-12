export function buildLocalFileContentUrl(filePath: string, options: { download?: boolean } = {}) {
  const url = `/api/local-files/content/${encodeURIComponent(filePath)}`
  return options.download ? `${url}?download=1` : url
}

export function buildLocalMarkdownPreviewUrl(filePath: string) {
  return `/api/local-files/markdown-preview/${encodeURIComponent(filePath)}`
}

export interface LocalMarkdownPreviewTarget {
  filePath: string
}

export function parseLocalMarkdownPreviewUrl(address: string): LocalMarkdownPreviewTarget | null {
  if (!address) return null

  let pathname: string
  if (address.startsWith("/")) {
    pathname = address
  } else {
    try {
      pathname = new URL(address).pathname
    } catch {
      return null
    }
  }

  const match = pathname.match(/^\/api\/local-files\/markdown-preview\/(.+)$/)
  if (!match) return null

  try {
    const filePath = decodeURIComponent(match[1] ?? "")
    if (!isAbsoluteLocalPath(filePath) || !isLocalMarkdownPreviewPath(filePath)) return null
    return { filePath }
  } catch {
    return null
  }
}

export function parseLocalFileContentUrl(address: string): { filePath: string } | null {
  if (!address) return null

  let pathname: string
  if (address.startsWith("/")) {
    pathname = address
  } else {
    try {
      pathname = new URL(address).pathname
    } catch {
      return null
    }
  }

  const match = pathname.match(/^\/api\/local-files\/content\/(.+)$/)
  if (!match) return null

  try {
    const filePath = decodeURIComponent(match[1] ?? "")
    if (!isAbsoluteLocalPath(filePath) || !isLocalMarkdownPreviewPath(filePath)) return null
    return { filePath }
  } catch {
    return null
  }
}

export function isLocalMarkdownPreviewPath(filePath: string) {
  const extension = getLocalFileExtension(filePath)
  return extension === ".md" || extension === ".markdown" || extension === ".mdown"
}

function isAbsoluteLocalPath(filePath: string) {
  if (filePath.includes("\0")) return false
  return filePath.startsWith("/") || /^[a-z]:[\\/]/i.test(filePath)
}

function getLocalFileExtension(filePath: string) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
}
