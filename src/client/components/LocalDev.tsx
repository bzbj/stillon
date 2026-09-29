import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  CodeXml,
  Copy,
  Loader2,
  Monitor,
  Plus,
  Star,
  Terminal,
} from "lucide-react"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { LocalDirectoryListResult, ResolvedLocalPath } from "../../shared/protocol"
import type { CodexTransport, SidebarProjectGroup } from "../../shared/types"
import type { SocketStatus } from "../app/socket"
import type { StillOnState } from "../app/useStillOnState"
import { PageHeader } from "../app/PageHeader"
import { resolveHomeProject } from "../lib/defaultProject"
import { NewProjectModal } from "./NewProjectModal"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

const ChatInput = lazy(() => import("./chat-ui/ChatInput").then(({ ChatInput }) => ({ default: ChatInput })))

interface LocalDevProps {
  connectionStatus: SocketStatus
  ready: boolean
  projectGroups: SidebarProjectGroup[]
  sidebarReady: boolean
  defaultProjectId: string | null
  onDefaultProjectChange: (projectId: string | null) => void
  onSend: StillOnState["handleSend"]
  availableProviders: StillOnState["availableProviders"]
  preferencesReady: boolean
  codexTransport: CodexTransport | null
  commandError: string | null
  newProjectOpen: boolean
  onNewProjectOpenChange: (open: boolean) => void
  onCreateProject: (project: { mode: "new" | "existing"; localPath: string; title: string }) => Promise<void>
  onListDirectories: (localPath?: string) => Promise<LocalDirectoryListResult>
  onResolveLocalPath: (localPath: string) => Promise<ResolvedLocalPath>
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center group bg-background border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <ChevronRight className="inline h-4 w-4 opacity-40" />
        <code>{children}</code>
      </pre>
      <CopyButton text={children} />
    </div>
  )
}

function InfoCard({ children }: { children: ReactNode }) {
  return <div className="bg-card border border-border rounded-2xl p-4">{children}</div>
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
      {children}
    </h2>
  )
}

function HowItWorksItem({
  icon: Icon,
  title,
  subtitle,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle: string
  iconClassName?: string
}) {
  return (
    <div className="flex flex-col items-center gap-0">
      <div className="p-3 mb-2 rounded-xl bg-background border border-border">
        <Icon className={iconClassName || "h-8 w-8 text-muted-foreground"} />
      </div>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </div>
  )
}

function HowItWorksConnector() {
  return <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
}

function Step({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
          <div className="flex-shrink-0 flex items-center justify-center font-medium text-logo">{number}.</div>
          <h3 className="font-medium text-foreground mb-2">{title}</h3>
        </div>
        <div className="text-muted-foreground text-sm space-y-3">{children}</div>
      </div>
    </div>
  )
}

export function LocalDev({
  connectionStatus,
  ready,
  projectGroups,
  sidebarReady,
  defaultProjectId,
  onDefaultProjectChange,
  onSend,
  availableProviders,
  preferencesReady,
  codexTransport,
  commandError,
  newProjectOpen,
  onNewProjectOpenChange,
  onCreateProject,
  onListDirectories,
  onResolveLocalPath,
}: LocalDevProps) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const selectedProject = resolveHomeProject(projectGroups, selectedProjectId, defaultProjectId)
  const isConnecting = connectionStatus === "connecting" || !ready
  const isConnected = connectionStatus === "connected" && ready

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
      {!isConnected ? (
        <>
          <PageHeader
            narrow
            icon={CodeXml}
            title={isConnecting ? `Connecting ${APP_NAME}` : `Connect ${APP_NAME}`}
            subtitle={isConnecting
              ? `${APP_NAME} is starting up and loading your local projects.`
              : `Run ${APP_NAME} directly on your machine with full access to your local files and agent project history.`}
          />
          <div className="max-w-2xl w-full mx-auto pb-12 px-6">
            <SectionHeader>Status</SectionHeader>
            <div className="mb-8">
              <InfoCard>
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                  <span className="text-sm text-muted-foreground">
                    {isConnecting ? (
                      `Connecting to your local ${APP_NAME} server...`
                    ) : (
                      <>
                        Not connected. Run <code className="bg-background border border-border rounded-md mx-0.5 p-1 font-mono text-xs text-foreground">{getCliInvocation()}</code> from any terminal on this machine.
                      </>
                    )}
                  </span>
                </div>
              </InfoCard>
            </div>

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>How it works</SectionHeader>
              <InfoCard>
                <div className="flex items-center justify-around gap-6 py-4 px-2">
                  <HowItWorksItem icon={Terminal} title={`${APP_NAME} CLI`} subtitle="On Your Machine" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={Monitor} title={`${APP_NAME} Server`} subtitle="Local WebSocket" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={CodeXml} title={`${APP_NAME} UI`} subtitle="Project Chat" />
                </div>
              </InfoCard>
              </div>
            ) : null}

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>Setup</SectionHeader>
              <InfoCard>
                <div className="space-y-4">
                  <Step number={1} title={`Start ${APP_NAME}`}>
                    <p>Run this command in your terminal:</p>
                    <CodeBlock>{getCliInvocation()}</CodeBlock>
                  </Step>

                  <Step number={2} title="Open the local UI">
                    <p>{APP_NAME} serves the app locally and opens the Local Projects page in an app-style browser window.</p>
                    <CodeBlock>http://localhost:3210/local</CodeBlock>
                  </Step>

                  <div className="mt-8">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Notes</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("").trim()}</code>
                        <span className="text-muted-foreground">Start in the current directory</span>
                      </div>
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("--no-open")}</code>
                        <span className="text-muted-foreground">Start the server without opening the browser</span>
                      </div>
                    </div>
                  </div>
                </div>
              </InfoCard>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex flex-1 min-h-0 items-center justify-center px-4 py-12 sm:px-8">
          <div className="w-full max-w-[740px]">
            <div className="mb-12 px-3 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">What would you like to build?</h1>
            </div>

            <div className="mb-1.5 flex items-center px-3">
              <Popover open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Choose project"
                    disabled={!sidebarReady}
                    className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/70 disabled:opacity-50"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="max-w-[240px] truncate">{selectedProject?.sidebarTitle ?? selectedProject?.title ?? (sidebarReady ? "Choose a project" : "Loading projects")}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={5} className="w-60 rounded-xl p-1 text-[13px] shadow-md">
                  <div className="max-h-64 overflow-y-auto" aria-label="Projects">
                    {projectGroups.map((group) => (
                      <button
                        key={group.groupKey}
                        type="button"
                        aria-pressed={selectedProject?.groupKey === group.groupKey}
                        onClick={() => { setSelectedProjectId(group.groupKey); setProjectMenuOpen(false) }}
                        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      >
                        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{group.sidebarTitle ?? group.title}</span>
                        {selectedProject?.groupKey === group.groupKey ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                      </button>
                    ))}
                  </div>
                  <div className="my-1 border-t border-border/70" />
                  {selectedProject ? (
                    <button
                      type="button"
                      onClick={() => {
                        onDefaultProjectChange(defaultProjectId === selectedProject.groupKey ? null : selectedProject.groupKey)
                        setProjectMenuOpen(false)
                      }}
                      className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-muted-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    >
                      <Star className="h-4 w-4" fill={defaultProjectId === selectedProject.groupKey ? "currentColor" : "none"} />
                      {defaultProjectId === selectedProject.groupKey ? "Clear default project" : "Set as default project"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { setProjectMenuOpen(false); onNewProjectOpenChange(true) }}
                    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <Plus className="h-4 w-4" /> Add project…
                  </button>
                </PopoverContent>
              </Popover>
            </div>

            {sidebarReady && projectGroups.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-muted-foreground">Add a project to start a conversation.</p>
            ) : null}
            <Suspense fallback={<div className="mx-3 h-16 animate-pulse rounded-[29px] border border-border bg-card" aria-label="Loading composer" />}>
              <ChatInput
                onSubmit={(content, options) => onSend(content, options, selectedProject?.groupKey)}
                disabled={!sidebarReady || !selectedProject || !preferencesReady}
                projectId={selectedProject?.groupKey ?? null}
                chatId={null}
                activeProvider={null}
                codexTransport={codexTransport}
                preferencesReady={preferencesReady}
                availableProviders={availableProviders}
              />
            </Suspense>
            {commandError ? (
              <div role="alert" className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3 mt-4">
                {commandError}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <NewProjectModal
        open={newProjectOpen}
        onOpenChange={onNewProjectOpenChange}
        onConfirm={(project) => {
          void onCreateProject(project)
        }}
        onListDirectories={onListDirectories}
        onResolveLocalPath={onResolveLocalPath}
      />

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
