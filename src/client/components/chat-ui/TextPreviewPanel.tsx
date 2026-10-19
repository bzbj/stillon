import { useEffect, useRef, useState } from "react"
import { fetchTextPreview, TEXT_PREVIEW_LIMIT_BYTES } from "../messages/attachmentPreview"
export function TextPreviewPanel({ src, name, zoom, refreshVersion, address }: { src: string; name: string; zoom: number; refreshVersion: number; address: string }) {
  const [value, setValue] = useState<{ content?: string; error?: string }>()
  const container = useRef<HTMLDivElement>(null), text = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const match = /^#L(\d+)(?:C(\d+))?$/u.exec(new URL(address, window.location.origin).hash)
    if (!match || !value?.content || !container.current || !text.current?.firstChild) return
    let offset = 0
    for (let line = 1; line < Number(match[1]); line++) {
      const next = value.content.indexOf("\n", offset)
      if (next < 0) return
      offset = next + 1
    }
    offset = Math.min(value.content.length, offset + Math.max(0, Number(match[2] ?? 1) - 1))
    const range = document.createRange()
    range.setStart(text.current.firstChild, offset); range.setEnd(text.current.firstChild, Math.min(value.content.length, offset + 1))
    container.current.scrollTop += range.getBoundingClientRect().top - container.current.getBoundingClientRect().top - 16
  }, [address, value, zoom])
  useEffect(() => {
    let active = true
    setValue(undefined)
    void fetchTextPreview(src, TEXT_PREVIEW_LIMIT_BYTES).then(result => {
      if (active) setValue(result.truncated ? { error: "Text preview exceeds 1 MB. Download the original file to read all content." } : { content: result.content })
    }).catch(e => { if (active) setValue({ error: e.message }) })
    return () => { active = false }
  }, [src, refreshVersion])
  return <div ref={container} className="h-full overflow-auto p-5"><p className="mb-4 break-all text-xs text-muted-foreground">{name}</p>
    {value?.error ? <p role="alert">{value.error}</p> : value?.content !== undefined ? <pre ref={text} className="whitespace-pre-wrap break-words font-mono text-sm" style={{ zoom }}>{value.content}</pre> : <p>Loading text preview…</p>}
  </div>
}
