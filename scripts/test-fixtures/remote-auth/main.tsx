import { createRoot } from "react-dom/client"
import { createPortal } from "react-dom"
import { useEffect } from "react"
import { useAppAuthState } from "../../../src/client/app/useAppAuthState"
import { AuthenticatedSessionBoundary } from "../../../src/client/app/AuthenticatedSessionBoundary"
import "./styles.css"

const fixture = {
  mode: "valid", requests: 0, settled: 0, viewRequests: 0, mounts: 0, unmounts: 0, hold: false,
  pending: [] as Array<() => void>,
  release() { for (const resolve of fixture.pending.splice(0)) resolve() },
  state: () => ({ mode: fixture.mode, requests: fixture.requests, settled: fixture.settled, viewRequests: fixture.viewRequests, mounts: fixture.mounts, unmounts: fixture.unmounts,
    checking: Boolean(document.querySelector("dialog")?.open), pending: fixture.pending.length,
    draft: (document.querySelector("#draft") as HTMLInputElement | null)?.value,
    scroll: document.querySelector("#history")?.scrollTop, timeOrigin: performance.timeOrigin }),
  focus: () => window.dispatchEvent(new Event("focus")),
}
;(window as any).remoteAuthFixture = fixture
const originalFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
  if (String(input) === "/api/sidebar-view") {
    fixture.viewRequests++
    return fixture.mode === "view-error"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ machineName: "Fixture computer", workspaceCollapsed: {}, sidebarCollapsed: false })
  }
  if (String(input) !== "/auth/status") return originalFetch(input, options)
  fixture.requests++
  const mode = fixture.mode
  if (fixture.hold) await new Promise<void>(resolve => fixture.pending.push(resolve))
  fixture.settled++
  if (mode === "network-error") throw new Error("Synthetic network failure")
  if (mode === "http-error") return new Response("unavailable", { status: 503 })
  return Response.json({ mode: "connect", enabled: true, authenticated: mode !== "expired", cacheScope: null,
    host: mode === "expired" ? undefined : { name: "Fixture computer", online: mode !== "offline" }, loginUrl: "/login", portalUrl: "/" })
}) as typeof fetch

function PrivatePage() {
  useEffect(() => { fixture.mounts++; return () => { fixture.unmounts++ } }, [])
  return <section>
    <h1>Private fixture workspace</h1>
    <input id="draft" aria-label="Unsent draft" defaultValue="" />
    <div id="history" style={{ height: 160, overflow: "auto" }}>
      {Array.from({ length: 100 }, (_, i) => <p key={i}>Synthetic message {i}</p>)}
    </div>
    {createPortal(<button id="private-portal" style={{ position: "fixed", bottom: 0, right: 0, zIndex: 2147483647 }}>Private portal action</button>, document.body)}
  </section>
}
function Probe() {
  const { state } = useAppAuthState()
  return <AuthenticatedSessionBoundary authenticated={state.status === "ready"} checking={state.status === "checking"} fallback={<p>Session ended</p>}>
    {state.status === "ready" ? <PrivatePage /> : null}
  </AuthenticatedSessionBoundary>
}
createRoot(document.getElementById("root")!).render(<Probe />)
