import { useEffect, useState } from "react"
import { FileImage } from "lucide-react"
import { cn } from "../../lib/utils"

const RETRY_DELAYS_MS = [500, 1500, 3000]

interface Props {
  src: string
  alt: string
  className?: string
  loading?: "eager" | "lazy"
}

export function AttachmentImage(props: Props) {
  // Upload completion or switching attachments must cancel the old retries.
  return <ImageWithRetry key={props.src} {...props} />
}

function ImageWithRetry({ src, alt, className, loading }: Props) {
  const [state, setState] = useState({ attempt: 0, retries: 0, failed: false })

  useEffect(() => {
    if (!state.failed) return
    const delay = RETRY_DELAYS_MS[state.retries]
    if (delay === undefined) return
    const timer = window.setTimeout(() => {
      setState(current => ({ attempt: current.attempt + 1, retries: current.retries + 1, failed: false }))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [state.failed, state.retries])

  useEffect(() => {
    if (!state.failed) return
    const retry = () => setState(current => ({ attempt: current.attempt + 1, retries: 0, failed: false }))
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [state.failed])

  if (state.failed && state.retries >= RETRY_DELAYS_MS.length) {
    return (
      <span role="img" aria-label={`${alt} preview unavailable`} className={cn(className, "flex flex-col items-center justify-center gap-2 text-muted-foreground")}>
        <FileImage className="size-8" />
        <span className="text-xs">Image unavailable</span>
      </span>
    )
  }

  return (
    <img
      key={state.attempt}
      src={retryImageSrc(src, state.attempt)}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => setState(current => ({ ...current, failed: true }))}
    />
  )
}

function retryImageSrc(src: string, attempt: number) {
  if (!attempt || /^(data:|blob:)/i.test(src)) return src
  // A fresh URL avoids reusing a failed browser image-cache entry. Keep the
  // same authenticated endpoint, query parameters and fragment.
  const hash = src.indexOf("#")
  const base = hash < 0 ? src : src.slice(0, hash)
  const fragment = hash < 0 ? "" : src.slice(hash)
  return `${base}${base.includes("?") ? "&" : "?"}stillon-image-retry=${attempt}${fragment}`
}
