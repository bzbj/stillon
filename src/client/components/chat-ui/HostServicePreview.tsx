import { Copy } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { copyTextToClipboard } from "../../lib/clipboard"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog"
import "./HostServicePreview.css"

const IsolatedPreview = lazy(() => import("./IsolatedPreview").then(module => ({ default: module.IsolatedPreview })))

export const LOCAL_HTML_GENERATION_PROMPT = "请将当前页面生成一个可直接打开的本地 HTML 文件，保留主要视觉效果和前端交互，内嵌所需的 CSS、JavaScript 和展示资源，不依赖本机 Web 服务或外部 CDN。涉及后端功能时使用示例数据并标注。完成后给我可点击的 HTML 文件链接。"

// The parent keys this component by workspace and service origin. Consent lasts
// only while this viewer stays open; it is never persisted across visits.
export function HostServicePreview({ address, projectId, refreshVersion, zoom, onNavigate }: {
  address: string; projectId?: string; refreshVersion: number; zoom: number
  onNavigate: (address: string, mode?: "replace" | "pop") => void
}) {
  const [accepted, setAccepted] = useState(false)
  const [dialog, setDialog] = useState<"confirm" | "copy" | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle")
  const copyAttempt = useRef(0)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)

  useEffect(() => () => { copyAttempt.current++ }, [])
  useEffect(() => {
    if (copyState !== "copied") return
    const timer = setTimeout(() => setCopyState("idle"), 3_000)
    return () => clearTimeout(timer)
  }, [copyState])

  async function copyPrompt(button: HTMLButtonElement) {
    trigger.current = button
    const attempt = ++copyAttempt.current
    setCopyState("copying")
    const copied = await copyTextToClipboard(LOCAL_HTML_GENERATION_PROMPT)
    if (attempt !== copyAttempt.current) return
    setCopyState(copied ? "copied" : "idle")
    if (!copied) setDialog("copy")
  }

  if (accepted) return <Suspense fallback={<p role="status" className="p-6">Loading service preview…</p>}>
    <IsolatedPreview address={address} projectId={projectId} refreshVersion={refreshVersion} zoom={zoom} onNavigate={onNavigate} />
  </Suspense>

  return <>
    <div className="host-service-warning" data-preview-service-warning="">
      <div className="host-service-warning__layout">
        <section className="host-service-warning__state" aria-labelledby="host-service-warning-title">
          <svg className="host-service-warning__avatar" viewBox="0 0 64 64" aria-hidden="true">
            <path fill="#685cf1" d="M26 5C41 1 55 11 57 25C60 39 54 54 41 58C27 62 8 57 5 46C1 35 14 8 26 5Z" />
            <path fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" d="M29 20l5 7M41 15l5 7" />
          </svg>
          <h1 id="host-service-warning-title" className="host-service-warning__title">
            <span>你正在预览一个本机服务网页</span>
            <span>滚动和点击会明显卡顿</span>
          </h1>
          <p className="host-service-warning__address">{new URL(address).host}</p>
          <p className="host-service-warning__recommendation">建议让 AI 生成<strong>本地 HTML 文件</strong>，预览更流畅。</p>
          <div className="host-service-warning__actions">
            <Button variant="none" size="none" className="host-service-warning__primary" disabled={copyState === "copying"}
              onClick={event => { void copyPrompt(event.currentTarget) }}>
              <Copy aria-hidden="true" className="size-[15px]" />
              {copyState === "copied" ? "已复制提示词" : copyState === "copying" ? "正在复制…" : "复制本地 HTML 生成提示词"}
            </Button>
            <Button variant="none" size="none" className="host-service-warning__secondary" onClick={event => {
              trigger.current = event.currentTarget
              setDialog("confirm")
            }}>确认进入，继续预览本机服务网页 <span aria-hidden="true">↗</span></Button>
          </div>
          <p role="status" className="host-service-warning__copy-status">{copyState === "copied" ? "已复制，发给你的 AI 即可" : ""}</p>
        </section>
        <footer className="host-service-warning__signature">Still On</footer>
      </div>
    </div>
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null) }}>
      <DialogContent size="sm" className="w-[calc(100vw-2rem)] gap-4 p-6"
        onOpenAutoFocus={event => {
          event.preventDefault()
          if (dialog === "copy") { prompt.current?.focus(); prompt.current?.select() }
          else cancel.current?.focus()
        }}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }}>
        {dialog === "confirm" ? <>
          <DialogTitle className="pr-5 leading-normal">继续预览本机服务网页？</DialogTitle>
          <DialogDescription>滚动和点击会有明显延迟。</DialogDescription>
          <div className="flex flex-col items-center gap-1 pt-1">
            <Button ref={cancel} variant="none" size="none" className="host-service-warning__primary !w-full" onClick={() => setDialog(null)}>返回，使用本地 HTML</Button>
            <Button variant="none" size="none" className="host-service-warning__secondary" onClick={() => { setDialog(null); setAccepted(true) }}>确认进入</Button>
          </div>
        </> : <>
          <DialogTitle className="pr-5 leading-normal">复制后发给你的 AI</DialogTitle>
          <DialogDescription>自动复制不可用，请复制下方提示词。</DialogDescription>
          <textarea ref={prompt} readOnly aria-label="本地 HTML 生成提示词" value={LOCAL_HTML_GENERATION_PROMPT}
            className="min-h-44 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <Button variant="none" size="none" className="host-service-warning__primary !w-full" onClick={() => setDialog(null)}>完成</Button>
        </>}
      </DialogContent>
    </Dialog>
  </>
}
