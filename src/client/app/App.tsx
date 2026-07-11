import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { APP_NAME, SDK_CLIENT_APP } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { KannaSidebar } from "./KannaSidebar"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { useKannaState } from "./useKannaState"
import type { AppSettingsSnapshot } from "../../shared/types"

const VERSION_SEEN_STORAGE_KEY = "kanna:last-seen-version"
const AUTH_STATUS_RETRY_DELAY_MS = 500

const ChatPage = lazy(() => import("./ChatPage").then(({ ChatPage }) => ({ default: ChatPage })))
const SettingsPage = lazy(() => import("./SettingsPage").then(({ SettingsPage }) => ({ default: SettingsPage })))

function LoadingBlock({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={`animate-pulse rounded-md bg-muted/70 ${className}`} />
  )
}

function RouteLoadingFallback({ page }: { page: "chat" | "settings" }) {
  const loadingLabel = page === "chat" ? "Loading conversation…" : "Loading settings…"

  return (
    <div className="relative flex flex-1 min-w-0 overflow-hidden bg-background" aria-busy="true">
      <span className="sr-only" role="status">{loadingLabel}</span>
      {page === "chat" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-[72px] shrink-0 items-center border-b border-border px-5">
            <LoadingBlock className="h-4 w-36" />
          </div>
          <div className="flex-1 space-y-6 overflow-hidden px-5 pt-8 pb-40">
            <div className="mx-auto max-w-[800px] space-y-3">
              <LoadingBlock className="h-4 w-3/4" />
              <LoadingBlock className="h-4 w-2/5" />
            </div>
            <div className="mx-auto max-w-[800px] space-y-3">
              <LoadingBlock className="ml-auto h-4 w-2/3" />
              <LoadingBlock className="ml-auto h-4 w-1/3" />
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background px-5 pt-8 pb-5">
            <div className="mx-auto max-w-[800px] rounded-2xl border border-border/70 bg-card p-3">
              <LoadingBlock className="h-12 w-full" />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-6 p-5 lg:flex-row lg:p-8">
          <div className="flex shrink-0 gap-3 lg:w-52 lg:flex-col">
            <LoadingBlock className="h-9 flex-1 lg:w-full" />
            <LoadingBlock className="h-9 flex-1 lg:w-full" />
            <LoadingBlock className="h-9 flex-1 lg:w-full" />
          </div>
          <div className="flex-1 space-y-5">
            <LoadingBlock className="h-7 w-44" />
            <LoadingBlock className="h-4 w-full max-w-xl" />
            <LoadingBlock className="h-4 w-4/5 max-w-lg" />
            <div className="mt-8 space-y-4 rounded-2xl border border-border/70 p-5">
              <LoadingBlock className="h-4 w-32" />
              <LoadingBlock className="h-10 w-full max-w-md" />
              <LoadingBlock className="h-10 w-full max-w-md" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface AuthStatusResponse {
  enabled: boolean
  authenticated: boolean
}

type AppAuthState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "locked"; error: string | null }

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (!payload.enabled || payload.authenticated) {
    return { status: "ready" }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

export function getAppPageTitle(machineName: string | null | undefined, notificationCount = 0) {
  const normalizedMachineName = machineName?.trim()
  const baseTitle = normalizedMachineName ? `${normalizedMachineName} — ${APP_NAME}` : APP_NAME
  return notificationCount > 0 ? `[${notificationCount}] ${baseTitle}` : baseTitle
}

function PasswordScreen({
  error,
  onSubmit,
}: {
  error: string | null
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(password)
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md rounded-3xl border border-border bg-card shadow-sm">
        <CardHeader className="flex flex-col p-2 space-y-3 px-6 pt-6 pb-5 pl-[28px]">
          <div className="flex items-center gap-3">
            <img src="/stillon-mark.svg" alt="" className="h-8 w-8 rounded-lg object-contain" />
            <div>
              <CardTitle className="font-logo text-xl text-slate-600 dark:text-slate-100">{APP_NAME}</CardTitle>
            </div>
          </div>
          <CardDescription className="leading-6">
            Enter your password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
                {error}
              </div>
            ) : null}
            <Input
              id="kanna-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              disabled={submitting}
              className="h-11 rounded-2xl bg-background"
            />
            <Button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-11 w-full"
            >
              {submitting ? "Unlocking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function useAppAuthState() {
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const retryTimeoutRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    setState((current) => current.status === "ready" ? current : { status: "checking" })

    let response: Response
    try {
      response = await fetch("/auth/status", {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
    } catch {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (shouldRetryAuthStatusRequest(response.ok)) {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [refresh])

  const submitPassword = useCallback(async (password: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password, next: window.location.pathname + window.location.search }),
    })

    if (!response.ok) {
      setState({ status: "locked", error: "Incorrect password. Try again." })
      return
    }

    await refresh()
  }, [refresh])

  return {
    state,
    submitPassword,
  }
}

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

function KannaLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useKannaState(params.chatId ?? null)
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const machineName = state.appSettings?.machineName ?? state.localProjects?.machine.displayName ?? null
  const appPageTitle = getAppPageTitle(machineName, getNotificationTitleCount(state.sidebarData))
  const previousSidebarDataRef = useRef<ReturnType<typeof useKannaState>["sidebarData"] | null>(null)
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void state.handleCreateChat(projectId)
  }, [state.handleCreateChat])
  const handleSidebarForkChat = useCallback((chat: Parameters<typeof state.handleForkChat>[0]) => {
    void state.handleForkChat(chat)
  }, [state.handleForkChat])
  const handleSidebarRenameChat = useCallback((chat: Parameters<typeof state.handleRenameChat>[0]) => {
    void state.handleRenameChat(chat)
  }, [state.handleRenameChat])
  const handleSidebarRenameProject = useCallback((projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    void state.handleRenameProject(projectId, sidebarTitle, realTitle)
  }, [state.handleRenameProject])
  const handleSidebarShareChat = useCallback((chatId: string) => {
    void state.handleShareChat(chatId)
  }, [state.handleShareChat])
  const handleSidebarArchiveChat = useCallback((chat: Parameters<typeof state.handleArchiveChat>[0]) => {
    void state.handleArchiveChat(chat)
  }, [state.handleArchiveChat])
  const handleOpenArchivedChat = useCallback((chatId: string) => {
    void state.handleOpenArchivedChat(chatId)
  }, [state.handleOpenArchivedChat])
  const handleOpenAddProjectModal = useCallback(() => {
    state.openAddProjectModal()
  }, [state])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof state.handleDeleteChat>[0]) => {
    void state.handleDeleteChat(chat)
  }, [state.handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void state.handleCopyPath(localPath)
  }, [state.handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void state.handleHideProject(projectId)
  }, [state.handleHideProject])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void state.handleReorderProjectGroups(projectIds)
  }, [state.handleReorderProjectGroups])
  const handleOpenChangelog = useCallback(() => {
    navigate("/settings/changelog")
  }, [navigate])
  const sidebarElement = useMemo(() => (
    <KannaSidebar
      data={state.sidebarData}
      activeChatId={state.activeChatId}
      machineName={machineName ?? "This Machine"}
      connectionStatus={state.connectionStatus}
      ready={state.sidebarReady}
      open={state.sidebarOpen}
      collapsed={state.sidebarCollapsed}
      showMobileOpenButton={showMobileOpenButton}
      onOpen={state.openSidebar}
      onClose={state.closeSidebar}
      onCollapse={state.collapseSidebar}
      onExpand={state.expandSidebar}
      onCreateChat={handleSidebarCreateChat}
      onForkChat={handleSidebarForkChat}
      currentProjectId={state.activeProjectId}
      keybindings={state.keybindings}
      onRenameChat={handleSidebarRenameChat}
      onShareChat={handleSidebarShareChat}
      onArchiveChat={handleSidebarArchiveChat}
      onOpenArchivedChat={handleOpenArchivedChat}
      onDeleteChat={handleSidebarDeleteChat}
      onOpenAddProjectModal={handleOpenAddProjectModal}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onRenameProject={handleSidebarRenameProject}
      onHideProject={handleSidebarHideProject}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
      editorLabel={state.editorLabel}
      updateSnapshot={state.updateSnapshot}
      onOpenChangelog={handleOpenChangelog}
    />
  ), [
    handleOpenChangelog,
    handleOpenAddProjectModal,
    handleSidebarCopyPath,
    handleSidebarCreateChat,
    handleSidebarArchiveChat,
    handleSidebarDeleteChat,
    handleOpenArchivedChat,
    handleSidebarForkChat,
    handleSidebarOpenExternalPath,
    handleSidebarRenameProject,
    handleSidebarRenameChat,
    handleSidebarShareChat,
    handleSidebarReorderProjectGroups,
    handleSidebarHideProject,
    machineName,
    showMobileOpenButton,
    state.activeChatId,
    state.activeProjectId,
    state.keybindings,
    state.closeSidebar,
    state.collapseSidebar,
    state.connectionStatus,
    state.editorLabel,
    state.expandSidebar,
    state.openSidebar,
    state.sidebarCollapsed,
    state.sidebarData,
    state.sidebarOpen,
    state.sidebarReady,
    state.updateSnapshot,
  ])

  useEffect(() => {
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate("/settings/changelog", { replace: true })
  }, [currentVersion, location.pathname, navigate])

  useLayoutEffect(() => {
    document.title = appPageTitle
  }, [appPageTitle, location.key])

  useEffect(() => {
    function handlePageShow() {
      document.title = appPageTitle
    }

    function handlePageHide() {
      document.title = appPageTitle
    }

    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pageshow", handlePageShow)
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [appPageTitle])

  useEffect(() => {
    const burstCount = getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
    previousSidebarDataRef.current = state.sidebarData

    if (burstCount <= 0) return
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.appSettings, state.sidebarData])

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      {sidebarElement}
      <Outlet context={state} />
      <StandaloneShareDialog
        open={Boolean(state.standaloneShareUrl)}
        shareUrl={state.standaloneShareUrl ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            state.handleCloseStandaloneShareDialog()
          }
        }}
        onOpenLink={state.handleOpenStandaloneShareLink}
        onCopyLink={state.handleCopyStandaloneShareLink}
      />
    </div>
  )
}

export function App() {
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">
        Checking session…
      </div>
    )
  }

  if (auth.state.status === "locked") {
    return <PasswordScreen error={auth.state.error} onSubmit={auth.submitPassword} />
  }

  return (
    <TooltipProvider>
      <AppDialogProvider>
        <Routes>
          <Route element={<KannaLayout />}>
            <Route path="/" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route
              path="/settings/:sectionId"
              element={(
                <Suspense fallback={<RouteLoadingFallback page="settings" />}>
                  <SettingsPage />
                </Suspense>
              )}
            />
            <Route
              path="/chat/:chatId"
              element={(
                <Suspense fallback={<RouteLoadingFallback page="chat" />}>
                  <ChatPage />
                </Suspense>
              )}
            />
          </Route>
        </Routes>
      </AppDialogProvider>
    </TooltipProvider>
  )
}
