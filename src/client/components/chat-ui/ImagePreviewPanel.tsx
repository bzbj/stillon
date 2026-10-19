import { IMAGE_PREVIEW_MAX_PIXELS } from "../../../shared/file-renderers"
import { useEffect, useRef, useState } from "react"

export function ImagePreviewPanel(props: { src: string; name: string; zoom: number }) {
  return <ImageSurface key={props.src} {...props} />
}
function ImageSurface({ src, name, zoom }: { src: string; name: string; zoom: number }) {
  const [attempt, setAttempt] = useState(0), [error, setError] = useState<string>(), [loaded, setLoaded] = useState(false)
  const diagnostic = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => diagnostic.current?.abort(), [])
  const fail = () => {
    diagnostic.current?.abort()
    const controller = new AbortController()
    diagnostic.current = controller
    setError("Image cannot be read. Retry or check file access.")
    // The GET endpoint enforces the 25 MB byte limit and authorization. A
    // successful image needs no preceding HEAD; diagnose only failed loads.
    void fetch(src, { method: "HEAD", cache: "no-store", signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return
      setError(response.status === 413 ? "Image exceeds the 25 MB preview limit." : response.status === 404 ? "Image was not found." : response.status === 410 ? "Image authorization expired. Reopen the original link." : "Image cannot be read. Check file access and reconnect.")
    }).catch(() => {})
  }
  return <div className="h-full overflow-auto bg-muted/20 p-4">
    <p className="mb-4 break-all text-xs text-muted-foreground">{name}</p>
    <div className="min-h-0" style={{ zoom }}>
      {error ? <p role="alert">{error}</p> : <>
        {!loaded ? <p role="status">Loading image…</p> : null}
        <img key={attempt} src={attempt ? `${src}${src.includes("?") ? "&" : "?"}stillon-image-retry=${attempt}` : src} alt={name} loading="eager" className="mx-auto block h-auto max-w-full object-contain"
          onLoad={event => {
            const image = event.currentTarget
            if (image.naturalWidth * image.naturalHeight > IMAGE_PREVIEW_MAX_PIXELS) setError("Image exceeds the 40 megapixel display limit.")
            else setLoaded(true)
          }} onError={fail} />
      </>}
      <button className="mt-4 text-xs underline" onClick={() => { diagnostic.current?.abort(); setError(undefined); setLoaded(false); setAttempt(value => value + 1) }}>Retry image</button>
    </div>
  </div>
}
