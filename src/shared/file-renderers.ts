import { isProjectTextPreviewPath } from "./project-file-urls"

export type FileRenderer = "html" | "markdown" | "text" | "image"
export const IMAGE_MIME_TYPES: Record<string, string> = { apng: "image/apng", avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/vnd.microsoft.icon", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" }
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES)
export function imageContentType(filePath: string) { const type = IMAGE_MIME_TYPES[filePath.split(".").pop()!.toLowerCase()]; return typeof type === "string" ? type : undefined }
export function fileRenderer(filePath: string): FileRenderer | undefined {
  const name = filePath.replaceAll("\\", "/").split("/").pop() ?? ""
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (["html", "htm"].includes(extension)) return "html"
  if (["md", "markdown", "mdown"].includes(extension)) return "markdown"
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return "image"
  if (isProjectTextPreviewPath(filePath)) return "text"
}

export const FILE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
export const IMAGE_PREVIEW_MAX_PIXELS = 40_000_000
