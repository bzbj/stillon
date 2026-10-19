import { createRoot } from "react-dom/client"
import { createPortal } from "react-dom"
import { useEffect, useState } from "react"
import { MemoryRouter } from "react-router-dom"
import { TooltipProvider } from "../../../src/client/components/ui/tooltip"
import { StillOnSidebar } from "../../../src/client/app/StillOnSidebar"
import { LocalDev } from "../../../src/client/components/LocalDev"
import { PROVIDERS } from "../../../src/shared/types"
import { getResourceEpoch } from "../../../src/client/lib/resourceRequests"
import "../../../src/index.css"
import { UserMessage } from "../../../src/client/components/messages/UserMessage"
import { useAppAuthState } from "../../../src/client/app/useAppAuthState"
import { AuthenticatedSessionBoundary } from "../../../src/client/app/AuthenticatedSessionBoundary"
import "./styles.css"

const fixture = {
  mode: "valid", requests: 0, settled: 0, viewRequests: 0, mounts: 0, unmounts: 0, hold: new URL(location.href).searchParams.has("hold-auth"),
  automaticPolling: false, authStatus: "checking", checkId: 0, scope: "session-a",
  polling: new Map<number, () => void>(),
  poll: () => { for (const callback of fixture.polling.values()) callback() },
  setConnection: (_status: "connected" | "connecting" | "disconnected") => {},
  pending: [] as Array<() => void>,
  release() { for (const resolve of fixture.pending.splice(0)) resolve() },
  state: () => ({ mode: fixture.mode, requests: fixture.requests, settled: fixture.settled, viewRequests: fixture.viewRequests, mounts: fixture.mounts, unmounts: fixture.unmounts,
    checking: Boolean(document.querySelector('dialog[aria-label="Checking session"]')?.open), authStatus: fixture.authStatus, checkId: fixture.checkId, resourceEpoch: getResourceEpoch(), pending: fixture.pending.length,
    draft: (document.querySelector("#draft") as HTMLInputElement | null)?.value,
    scroll: document.querySelector("#history")?.scrollTop, timeOrigin: performance.timeOrigin }),
  focus: () => window.dispatchEvent(new Event("focus")),
  setImageSource: (_source: string) => {},
}
;(window as any).remoteAuthFixture = fixture
const originalInterval = window.setInterval.bind(window)
const originalClearInterval = window.clearInterval.bind(window)
window.setInterval = ((callback: () => void, delay?: number) => {
  if (delay !== 15000) return originalInterval(callback, delay)
  const id = originalInterval(() => { if (fixture.automaticPolling) callback() }, delay)
  fixture.polling.set(id, callback)
  return id
}) as typeof window.setInterval
window.clearInterval = (id) => { fixture.polling.delete(id!); originalClearInterval(id) }
const originalFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
  if (String(input) === "/api/sidebar-view") {
    fixture.viewRequests++
    return fixture.mode === "view-error"
      ? new Response("unavailable", { status: 503 })
      : Response.json({ machineName: "Fixture computer", workspaceCollapsed: {}, workspaceCollapseVersions: {} })
  }
  if (String(input) !== "/auth/status") return originalFetch(input, options)
  fixture.requests++
  const mode = fixture.mode
  if (fixture.hold) await new Promise<void>(resolve => fixture.pending.push(resolve))
  fixture.settled++
  if (mode === "network-error") throw new Error("Synthetic network failure")
  if (mode === "http-error") return new Response("unavailable", { status: 503 })
  if (mode === "malformed") return Response.json({})
  return Response.json({ mode: "connect", enabled: true, authenticated: mode !== "expired", cacheScope: fixture.scope,
    host: mode === "expired" ? undefined : { name: "Fixture computer", online: mode !== "offline" }, loginUrl: "/login", portalUrl: "/" })
}) as typeof fetch

function PrivatePage() {
  useEffect(() => { fixture.mounts++; return () => { fixture.unmounts++ } }, [])
  const [imageSource, setImageSource] = useState("/screenshot-light.png?attachment=first")
  useEffect(() => { fixture.setImageSource = setImageSource }, [])
  const [connection, setConnection] = useState<"connected" | "connecting" | "disconnected">("connected")
  useEffect(() => { fixture.setConnection = setConnection }, [])
  const chat = { _id: "synthetic-chat", _creationTime: 1, chatId: "synthetic-chat", title: "Saved conversation", status: "idle" as const, unread: false, localPath: "/synthetic/project", provider: "codex" as const, lastMessageAt: 1, hasAutomation: false, canFork: true }
  return <section style={{ display: "flex" }}>
    <StillOnSidebar data={{ projectGroups: [{ groupKey: "synthetic-project", title: "Synthetic Project", realTitle: "synthetic-project", localPath: "/synthetic/project", chats: [chat], previewChats: [chat], olderChats: [], defaultCollapsed: false }] }} activeChatId="synthetic-chat" machineName="Fixture computer" connectionStatus={connection} ready snapshotStatus="authoritative" open={false} collapsed={false} showMobileOpenButton={false}
      onOpen={() => {}} onClose={() => {}} onCollapse={() => {}} onExpand={() => {}} onCreateChat={() => {}} onForkChat={() => {}} currentProjectId="synthetic-project" keybindings={null} onRenameChat={() => {}} onShareChat={() => {}} onArchiveChat={() => {}} onOpenArchivedChat={() => {}} onDeleteChat={() => {}} onOpenAddProjectModal={() => {}} onCopyPath={() => {}} onOpenExternalPath={() => {}} onRenameProject={() => {}} onHideProject={() => {}} onReorderProjectGroups={() => {}} />
    <main style={{ padding: 24, minWidth: 0, flex: 1, height: "100dvh", overflowY: "auto" }}>
    <h1>Private fixture workspace</h1>
    <input id="draft" aria-label="Unsent draft" defaultValue="" />
    <UserMessage content="Image recovery fixture" attachments={[{
      id: "fixture-image", kind: "image", displayName: "fixture-image.png", mimeType: "image/png",
      absolutePath: "", relativePath: "", contentUrl: imageSource, size: 1024,
    }]} />
    <div id="history" style={{ height: 160, overflow: "auto" }}>
      {Array.from({ length: 100 }, (_, i) => <p key={i}>Synthetic message {i}</p>)}
    </div>
    <LocalDev connectionStatus={connection} ready projectGroups={[{ groupKey: "synthetic-project", title: "Synthetic Project", realTitle: "synthetic-project", localPath: "/synthetic/project", chats: [chat], previewChats: [chat], olderChats: [], defaultCollapsed: false }]} sidebarReady defaultProjectId={null} onDefaultProjectChange={() => {}} onSend={async () => {}} availableProviders={PROVIDERS} preferencesReady codexTransport="app-server" commandError={null} newProjectOpen={false} onNewProjectOpenChange={() => {}} onCreateProject={async () => {}} onListDirectories={async () => { throw new Error("Not used in fixture") }} onResolveLocalPath={async () => { throw new Error("Not used in fixture") }} />
    {createPortal(<button id="private-portal" style={{ position: "fixed", bottom: 0, right: 0, zIndex: 2147483647 }}>Private portal action</button>, document.body)}
    </main>
  </section>
}
function Probe() {
  const { state } = useAppAuthState()
  fixture.authStatus = state.status
  fixture.checkId = state.status === "ready" ? state.checkId ?? 0 : 0
  return <AuthenticatedSessionBoundary authenticated={state.status === "ready"} checking={state.status === "checking"} fallback={<p>Session ended</p>}>
    {state.status === "ready" ? <PrivatePage key={state.cacheScope ?? "local"} /> : null}
  </AuthenticatedSessionBoundary>
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><TooltipProvider><Probe /></TooltipProvider></MemoryRouter>)
