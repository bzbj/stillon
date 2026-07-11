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

function toDownloadUrl(url: string) {
  if (typeof window === "undefined") return url
  const absoluteUrl = new URL(url, document.baseURI || window.location.href)
  absoluteUrl.searchParams.set("download", "1")
  return absoluteUrl.toString()
}
