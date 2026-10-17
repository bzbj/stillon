import { canOpenTranscriptFilesOnHost } from "../lib/transcriptLocalLinkPolicy"
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { APP_NAME } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { StillOnSidebar } from "./StillOnSidebar"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { useStillOnState } from "./useStillOnState"
import type { AppSettingsSnapshot } from "../../shared/types"
import { AuthenticatedSessionBoundary } from "./AuthenticatedSessionBoundary"
import { useAppAuthState } from "./useAppAuthState"

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
    <div data-stillon-part="page" className="relative flex flex-1 min-w-0 overflow-hidden bg-background" aria-busy="true">
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

export function getAppPageTitle(machineName: string | null | undefined, notificationCount = 0) {
  const normalizedMachineName = machineName?.trim()
  const baseTitle = normalizedMachineName ? `${APP_NAME} ${normalizedMachineName}` : APP_NAME
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
            Enter your password to continue. This optional application password can be any non-empty value; a simple password only deters casual access, so external deployments need an appropriate ingress policy.
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
              id="stillon-password"
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

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

function StillOnLayout({ cacheScope }: { cacheScope: string | null }) {
  const location = useLocation()
  const params = useParams()
  const state = useStillOnState(params.chatId ?? null, cacheScope)
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const machineName = state.machineName
  const appPageTitle = getAppPageTitle(machineName, getNotificationTitleCount(state.sidebarData))
  const previousSidebarDataRef = useRef<ReturnType<typeof useStillOnState>["sidebarData"] | null>(null)
  const previousSidebarSnapshotStatusRef = useRef(state.sidebarSnapshotStatus)
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
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_default", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void state.handleHideProject(projectId)
  }, [state.handleHideProject])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void state.handleReorderProjectGroups(projectIds)
  }, [state.handleReorderProjectGroups])
  const handleSidebarResize = useCallback((width: number) => {
    void state.handleWriteAppSettings({ appearance: { sidebarWidth: width } }).catch(() => undefined)
  }, [state.handleWriteAppSettings])
  const sidebarElement = useMemo(() => (
    <StillOnSidebar
      onResizeSidebar={handleSidebarResize}
      data={state.sidebarData}
      activeChatId={state.activeChatId}
      machineName={machineName}
      connectionStatus={state.connectionStatus}
      ready={state.sidebarReady}
      snapshotStatus={state.sidebarSnapshotStatus}
      open={state.sidebarOpen}
      collapsed={state.sidebarCollapsed}
      showMobileOpenButton={showMobileOpenButton}
      onOpen={state.openSidebar}
      onClose={state.closeSidebar}
      onCollapse={state.collapseSidebar}
      onExpand={state.expandSidebar}
      onCreateChat={handleSidebarCreateChat}
      onRunQuickCommand={state.quickCommandStarting || !state.composerPreferencesReady ? undefined : state.handleRunQuickCommand}
      onWriteQuickCommands={state.appSettings ? patch => state.handleWriteAppSettings({ quickCommands: patch }) : undefined}
      workspaceCollapsed={state.appSettings?.workspaceCollapsed}
      onWriteWorkspaceCollapsed={state.appSettings ? patch => state.handleWriteAppSettings({ workspaceCollapsed: patch }) : undefined}
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
      onOpenExternalPath={canOpenTranscriptFilesOnHost(window.location.hostname) ? handleSidebarOpenExternalPath : undefined}
      onRenameProject={handleSidebarRenameProject}
      onHideProject={handleSidebarHideProject}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
    />
  ), [
    handleSidebarResize,
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
    state.quickCommandStarting,
    state.composerPreferencesReady,
    state.appSettings,
    state.handleRunQuickCommand,
    state.handleWriteAppSettings,
    state.keybindings,
    state.closeSidebar,
    state.collapseSidebar,
    state.connectionStatus,
    state.expandSidebar,
    state.openSidebar,
    state.sidebarData,
    state.sidebarCollapsed,
    state.sidebarOpen,
    state.sidebarReady,
    state.sidebarSnapshotStatus,
  ])

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
    const burstCount = previousSidebarSnapshotStatusRef.current === "authoritative"
      ? getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
      : 0
    previousSidebarDataRef.current = state.sidebarData
    previousSidebarSnapshotStatusRef.current = state.sidebarSnapshotStatus

    if (burstCount <= 0) return
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.appSettings, state.sidebarData, state.sidebarSnapshotStatus])

  return (
    <div data-stillon-part="workspace" className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
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
  let fallback = null
  if (auth.state.status === "locked") {
    fallback = <PasswordScreen error={auth.state.error} onSubmit={auth.submitPassword} />
  }

  if (auth.state.status === "connect-unavailable") {
    const state = auth.state
    fallback = <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6"><div className="max-w-md space-y-5">
      <h1 className="text-2xl font-semibold">{state.host ? `${state.host.name} 暂时离线` : "远程登录已结束"}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{state.host ? "请确认电脑保持开机、联网且 StillOn 正在运行。恢复连接后可以继续使用。" : "重新验证邮箱后，可以继续使用这台电脑。电脑上的任务不会因退出登录而停止。"}</p>
      <div className="flex flex-wrap gap-5 text-sm"><a className="underline" href={state.loginUrl}>{state.host ? "重试连接" : "邮箱登录"}</a><a className="underline" href={`${state.portalUrl}/computers`}>我的电脑</a></div>
      {state.host && <form method="post" action="/_connect/logout"><Button variant="outline" type="submit">Logout · 退出远程登录</Button></form>}
    </div></div>
  }

  return (
    <AuthenticatedSessionBoundary authenticated={auth.state.status === "ready"} checking={auth.state.status === "checking"} fallback={fallback}>
      {auth.state.status === "ready" ? <AuthenticatedAppRoutes cacheScope={auth.state.cacheScope} /> : null}
    </AuthenticatedSessionBoundary>
  )
}

function AuthenticatedAppRoutes({ cacheScope }: { cacheScope: string | null }) {
  return (
    <TooltipProvider>
      <AppDialogProvider>
        <Routes>
          <Route element={<StillOnLayout cacheScope={cacheScope} />}>
            <Route path="/" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/welcome" replace />} />
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
