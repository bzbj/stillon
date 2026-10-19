import { AttachmentImage } from "../messages/AttachmentImage"
import { IMAGE_PREVIEW_MAX_PIXELS } from "../../../shared/file-renderers"
import { useEffect, useState } from "react"

export function ImagePreviewPanel({ src, name, zoom }: { src: string; name: string; zoom: number }) {
  const [attempt, setAttempt] = useState(0), [status, setStatus] = useState<string | null | undefined>()
  useEffect(() => {
    const controller = new AbortController()
    setStatus(undefined)
    void fetch(src, { method: "HEAD", cache: "no-store", signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(response.status === 413 ? "Image exceeds the 25 MB preview limit." : response.status === 404 ? "Image was not found." : response.status === 410 ? "Image authorization expired. Reopen the original link." : "Image cannot be read. Check file access and reconnect.")
      setStatus(null)
    }).catch(error => { if (!controller.signal.aborted) setStatus(error.message) })
    return () => controller.abort()
  }, [src, attempt])
  return <div className="h-full overflow-auto bg-muted/20 p-4">
    <p className="mb-4 break-all text-xs text-muted-foreground">{name}</p>
    <div className="min-h-0" style={{ zoom }}>
      {status ? <p role="alert">{status}</p> : status === null ? <AttachmentImage key={attempt} src={src} alt={name} loading="eager" maxPixels={IMAGE_PREVIEW_MAX_PIXELS}
        className="mx-auto block h-auto max-w-full object-contain" /> : <p>Loading image…</p>}
      <button className="mt-4 text-xs underline" onClick={() => setAttempt(value => value + 1)}>Retry image</button>
    </div>
  </div>
}
