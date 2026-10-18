import { parseProjectFilePreviewUrl } from "./project-file-urls"

export const PREVIEW_NAVIGATION_MESSAGE = "stillon:preview-navigation"

// A sandboxed document may request another preview in its current folder, but
// it cannot use the parent as an authenticated fetcher for arbitrary app URLs.
export function projectPreviewNavigationAddress(message: unknown, currentAddress: string) {
  if (!message || typeof message !== "object") return null
  const data = message as { type?: unknown; address?: unknown }
  if (data.type !== PREVIEW_NAVIGATION_MESSAGE || typeof data.address !== "string"
    || !data.address.startsWith("/") || data.address.startsWith("//")) return null
  const current = parseProjectFilePreviewUrl(currentAddress)
  const next = parseProjectFilePreviewUrl(data.address)
  if (!current || !next || !/\.html?$/iu.test(current.filePath) || next.projectId !== current.projectId) return null
  const directory = current.filePath.slice(0, current.filePath.lastIndexOf("/") + 1)
  if (!next.filePath.startsWith(directory)) return null
  const relative = next.filePath.slice(directory.length)
  if (!isPreviewResourcePath(relative)) return null
  return data.address
}

export function isPreviewResourcePath(relative: string) {
  return Boolean(relative) && !relative.split("/").some(part => !part || part === "." || part === ".."
    || part.startsWith(".") || /[\\\u0000:]/u.test(part))
    && /\.(?:html?|css|[cm]?js|json|svg|png|apng|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|wav|ogg|wasm|webmanifest)$/iu.test(relative)
}
