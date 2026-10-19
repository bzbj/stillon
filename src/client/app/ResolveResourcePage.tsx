import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { getLinkCapabilities } from "../lib/linkCapabilities"
import { registerResourceTarget } from "../lib/previewTarget"
import { executeResourceAction } from "../components/ResourceLink"
import { getLinkActions, type LinkAction } from "../../shared/link-actions"
import { parsePreviewTarget } from "../../shared/preview-target"
import { useStartupReveal } from "../lib/startup"

/** Native new-tab navigation resolves here; navigation can never launch an OS app. */
export function ResolveResourcePage() {
  const location = useLocation(), navigate = useNavigate()
  const [attempt, setAttempt] = useState(0), [error, setError] = useState<string>()
  const [actions, setActions] = useState<ReturnType<typeof getLinkActions>["actions"]>()
  useStartupReveal(Boolean(actions || error))
  const actionController = useRef<AbortController | undefined>(undefined)
  const query = new URLSearchParams(location.search)
  const address = query.get("address") ?? "", projectId = query.get("projectId") ?? undefined
  useEffect(() => {
    let active = true
    setError(undefined); setActions(undefined)
    void (async () => {
      const target = parsePreviewTarget(address, projectId)
      if (!target || target.kind === "external-http") throw new Error("This resource address is unavailable.")
      const [capabilities, registered] = await Promise.all([getLinkCapabilities(), registerResourceTarget(address, projectId)])
      const metadata = { kind: registered.directory ? "directory" as const : target.kind === "host-http" ? "service" as const : "file" as const,
        renderer: registered.renderer, canRead: true, canDownload: !registered.directory && target.kind !== "host-http" }
      if (!active) return
      const policy = getLinkActions({ kind: metadata.kind, renderer: metadata.renderer, local: capabilities.local,
        isMac: capabilities.isMac, readable: metadata.canRead, canDownload: metadata.canDownload })
      if (policy.defaultAction === "preview") {
        if (active) navigate(registered.url, { replace: true })
      } else if (policy.defaultAction === "download") {
        if (active) {
          setActions(policy.actions)
          window.location.assign(`/api/preview-targets/${registered.url.split("/").pop()}/content?download=1`)
        }
      } else setActions(policy.actions)
    })().catch(e => { if (active) setError(e.message) })
    return () => { active = false; actionController.current?.abort() }
  }, [address, projectId, attempt, navigate])
  const activate = (action: LinkAction) => {
    setError(undefined)
    actionController.current?.abort()
    const controller = new AbortController()
    actionController.current = controller
    void executeResourceAction(address, action, projectId, controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message) })
  }
  return <main className="mx-auto max-w-xl space-y-5 p-8">
    <h1 className="text-xl font-semibold">File actions</h1>
    {error ? <p role="alert">{error}</p> : !actions ? <p role="status">Resolving file actions…</p> : <>
      <p>{actions.length ? "Choose an action for this file." : "This resource has no available file actions."}</p>
      <div className="flex flex-wrap gap-4">{actions.filter(item => item.action !== "preview").map(item => <button type="button" key={item.action} disabled={item.disabled} className="underline" onClick={() => activate(item.action)}>{item.label}</button>)}</div>
    </>}
    {error ? <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry</button> : null}
  </main>
}
