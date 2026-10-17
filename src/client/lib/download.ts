export function downloadUrl(url: string, fileName: string) {
  if (typeof document === "undefined") return

  const anchor = document.createElement("a")
  anchor.href = toDownloadUrl(url)
  anchor.download = fileName
  anchor.rel = "noopener noreferrer"
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

export function downloadText(fileName: string, contents: string, contentType = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type: contentType }))
  downloadUrl(url, fileName)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function toDownloadUrl(url: string) {
  if (typeof window === "undefined") return url
  const absoluteUrl = new URL(url, document.baseURI || window.location.href)
  if (absoluteUrl.protocol === "blob:") return absoluteUrl.toString()
  absoluteUrl.searchParams.set("download", "1")
  return absoluteUrl.toString()
}
