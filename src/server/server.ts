import { ClaudeModelPolicyManager, type ClaudeModelDiscoveryOptions } from "./claude-model-policy-manager"
import { ProviderCliSettings } from "./provider-cli-settings"
import { createProviderSetup } from "./provider-setup"
import { handleProviderSetupRequest } from "./provider-setup-http"
import { ProviderCliUpdates, type ProviderCliUpdatesOptions } from "./provider-cli-updates"
import { handleProviderCliUpdates } from "./provider-cli-updates-http"
import { createCliEnvironment } from "./cli-environment"
import { handleAppearanceRequest } from "./appearance-assets"
import { WorkspaceAvatarsManager, handleWorkspaceAvatars } from "./workspace-avatars"
import { isProjectTextPreviewPath } from "../shared/project-file-urls"
import { LOCAL_PREVIEW_ASSET_PREFIX, PreviewResources, projectPreviewTarget, localHtmlPreviewTarget } from "./preview-resources"
import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { APP_VERSION, getRuntimeProfile, LOG_PREFIX } from "../shared/branding"
import { createManagedAppControl } from "./updater/app-control"
import { createManagedUpdateApi } from "./updater/api"
import { parseLocalFileContentUrl } from "../shared/local-file-urls"
import type { ChatAttachment } from "../shared/types"
import { createAuthManager } from "./auth"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { CodexModelPolicyManager, type CodexModelDiscoveryOptions } from "./codex-model-policy-manager"
import { AppSettingsManager } from "./app-settings"
import { getAgentNetworkStatus, mergeAgentNetworkEnvironment } from "./agent-environment"
import { detectSystemProxy, testAgentNetworkConnection } from "./agent-network"
import {
  DEFAULT_PROJECT_DISCOVERY_ADAPTERS,
  discoverProjectsIncrementally,
  isProjectDiscoverySnapshotFresh,
  mergeIncrementalDiscoveryUpdate,
  type DiscoveredProject,
} from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { createWsRouter, type ClientState } from "./ws-router"
import { SOCKET_TRANSPORT_QUERY } from "../shared/socket-transport"
import { handleBrowserPreviewProxy, rewriteRootRelativeReferences } from "./browser-preview-proxy"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { resolveProjectUploadFilePath } from "./paths"
import { migrateLegacyBrandDataRoot } from "./brand-migration"
import { createLocalHtmlPreviewManager, isLoopbackBindHost } from "./local-html-preview"
import { PreviewTargets } from "./preview-targets"
import { PreviewFiles, FileAccessError, FILE_PREVIEW_PROTOCOL } from "./preview-files"
import { PreviewBrowser, isWithinPreviewDirectory } from "./preview-browser"
import { REMOTE_SESSION_HEADER, REMOTE_EXPIRY_HEADER } from "./connect/adapter"
import { protectPreviewPort, protectedPreviewPorts, releasePreviewPort } from "./preview-ports"
import { generateTitleForChatDetailed } from "./generate-title"
import { QuickResponseAdapter } from "./quick-response"
import { readSubscriptionUsageSnapshot } from "./subscription-usage"
import { createSourceUpgradePromptGenerator } from "./source-upgrade-prompt"
import { serveStaticAsset } from "./static-assets"
import { appendHttpTiming } from "../shared/http-timing"
import { randomToken } from "./connect/crypto"
import { createConnector, type ConnectorOptions } from "./connect/connector"
import { validateIngress } from "./connect/ingress"
import { handleConnectLocal } from "./connect/local-api"
import { RemoteOperations } from "./connect/operations"
import { stopConnectListener } from "./connect/stop-server"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024
const MAX_REQUEST_BODY_SIZE_BYTES = 110 * 1024 * 1024
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000
const BACKGROUND_PROJECT_DISCOVERY_DELAY_MS = 1_000

export async function persistUploadedFiles(args: {
  projectId: string
  localPath: string
  files: File[]
  persistUpload?: typeof persistProjectUpload
}): Promise<ChatAttachment[]> {
  const persistUpload = args.persistUpload ?? persistProjectUpload
  const attachments: ChatAttachment[] = []

  try {
    for (const file of args.files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const attachment = await persistUpload({
        projectId: args.projectId,
        localPath: args.localPath,
        fileName: file.name,
        bytes,
        fallbackMimeType: file.type || undefined,
      })
      attachments.push(attachment)
    }
  } catch (error) {
    await Promise.allSettled(
      attachments.map((attachment) => deleteProjectUpload({
        localPath: args.localPath,
        storedName: path.basename(attachment.absolutePath),
      }))
    )
    throw error
  }

  return attachments
}

export interface StartStillOnServerOptions {
  providerCliUpdates?: Pick<ProviderCliUpdatesOptions, "inspect" | "release" | "install" | "verify">
  claudeModelDiscovery?: ClaudeModelDiscoveryOptions
  codexModelDiscovery?: CodexModelDiscoveryOptions
  port?: number
  host?: string
  openBrowser?: boolean
  dataDir?: string
  password?: string | null
  strictPort?: boolean
  /**
   * When true, the auth layer trusts X-Forwarded-Proto for CSRF origin
   * checks, redirect URLs, and the Secure cookie flag. The hostname still
   * comes from the request URL / Host header. Enable only when the server is
   * reachable solely through a trusted reverse proxy.
   */
  trustProxy?: boolean
  /** Explicit origins for an operator-managed reverse proxy. */
  allowedOrigins?: string[]
  connect?: Pick<ConnectorOptions, "origin" | "frpcPath" | "trustedCaFile">
  /** Alternate provider-history root for isolated installations and tests. */
  discoveryHome?: string
  uploadLimits?: {
    maxUploadSizeBytes?: number
  }
  onMigrationProgress?: (message: string) => void
}

export async function startStillOnServer(options: StartStillOnServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const maxUploadSizeBytes = options.uploadLimits?.maxUploadSizeBytes ?? MAX_UPLOAD_SIZE_BYTES
  if (!Number.isSafeInteger(maxUploadSizeBytes) || maxUploadSizeBytes <= 0) {
    throw new Error("uploadLimits.maxUploadSizeBytes must be a positive safe integer")
  }
  const auth = options.password ? createAuthManager(options.password, { trustProxy: options.trustProxy ?? false }) : null
  const localSecret = randomToken()
  let connector: Awaited<ReturnType<typeof createConnector>> | null = null
  const allowedOrigins = options.allowedOrigins ?? process.env.STILLON_ALLOWED_ORIGINS?.split(",").map(value => value.trim()) ?? []
  if (!options.dataDir) {
    const migration = await migrateLegacyBrandDataRoot()
    if (migration.status === "migrated") {
      console.log(`${LOG_PREFIX} moved existing data from ${migration.from} to ${migration.to}`)
    }
  }
  const cliEnvironment = createCliEnvironment()
  const store = new EventStore(options.dataDir)
  const providerCliSettings = new ProviderCliSettings(store.dataDir)
  const remoteOperations = new RemoteOperations(store.dataDir)
  const codexModelPolicy = new CodexModelPolicyManager(store.dataDir, {
    ...options.codexModelDiscovery,
    getEnvironment: () => getAgentEnvironment(),
  })
  await codexModelPolicy.initialize()
  const claudeModelPolicy = new ClaudeModelPolicyManager(store.dataDir, {
    ...options.claudeModelDiscovery, getEnvironment: () => getAgentEnvironment(),
  })
  await claudeModelPolicy.initialize()
  const machineDisplayName = getMachineDisplayName()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"), {
    defaultMachineName: machineDisplayName,
  })
  let providerCliUpdates: ProviderCliUpdates
  const getUpdateEnvironment = () => mergeAgentNetworkEnvironment(providerCliSettings.environment(cliEnvironment.get()), appSettings.getSnapshot().network)
  const getAgentEnvironment = () => {
    if (providerCliUpdates?.busy) throw new Error("A CLI update is in progress. Wait for verification before starting agent work.")
    return getUpdateEnvironment()
  }
  const getCodexApiTransport = () => appSettings.getSnapshot().codexApiTransport ?? "auto"
  const providerSetup = createProviderSetup({ dataDir: store.dataDir, getEnvironment: async () => { await cliEnvironment.refresh(); return getAgentEnvironment() } })
  await store.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  const savedDiscoveryProjects = () => store.listProjects().map((project) => ({
    localPath: project.localPath,
    title: project.title,
    modifiedAt: project.updatedAt,
  }))
  let discoveredProjects: DiscoveredProject[] = savedDiscoveryProjects()
  let discoveryRefresh: Promise<DiscoveredProject[]> | null = null
  let discoveryCompletedAt: number | null = null
  let forceDiscoveryRefreshPending = false
  const discoveryAbortController = new AbortController()
  let router: ReturnType<typeof createWsRouter>

  function refreshDiscovery(refreshOptions: { force?: boolean } = {}) {
    if (discoveryAbortController.signal.aborted) {
      return Promise.resolve(discoveredProjects)
    }
    discoveredProjects = mergeIncrementalDiscoveryUpdate({
      currentProjects: discoveredProjects,
      discoveredProjects: [],
      savedProjects: savedDiscoveryProjects(),
      complete: false,
    })
    if (discoveryRefresh) {
      if (refreshOptions.force) {
        forceDiscoveryRefreshPending = true
      }
      void router?.broadcastLocalProjectsSnapshots()
      return discoveryRefresh
    }
    if (!refreshOptions.force && isProjectDiscoverySnapshotFresh(discoveryCompletedAt)) {
      void router?.broadcastLocalProjectsSnapshots()
      return Promise.resolve(discoveredProjects)
    }

    discoveryRefresh = Promise.resolve().then(() => discoverProjectsIncrementally(
      options.discoveryHome,
      DEFAULT_PROJECT_DISCOVERY_ADAPTERS,
      {
        initialProjects: savedDiscoveryProjects(),
        signal: discoveryAbortController.signal,
        onUpdate: (projects, progress) => {
          // Keep already-visible projects stable during a refresh, then replace
          // them with the authoritative result once the scan completes.
          discoveredProjects = mergeIncrementalDiscoveryUpdate({
            currentProjects: discoveredProjects,
            discoveredProjects: projects,
            // Projects opened while this scan was running must survive its
            // final replacement snapshot.
            savedProjects: savedDiscoveryProjects(),
            complete: progress.complete,
          })
          void router?.broadcastLocalProjectsSnapshots()
        },
      }
    )).then((projects) => {
      discoveryCompletedAt = Date.now()
      return projects
    }).catch((error) => {
      if (!discoveryAbortController.signal.aborted) {
        console.warn(`${LOG_PREFIX} Failed to refresh local project history:`, error)
      }
      return discoveredProjects
    }).finally(() => {
      discoveryRefresh = null
      void router?.broadcastLocalProjectsSnapshots()
      if (forceDiscoveryRefreshPending && !discoveryAbortController.signal.aborted) {
        forceDiscoveryRefreshPending = false
        void refreshDiscovery({ force: true })
      }
    })

    void router?.broadcastLocalProjectsSnapshots()
    return discoveryRefresh
  }

  let server: ReturnType<typeof Bun.serve<ClientState>>
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  await appSettings.initialize()
  await keybindings.initialize()
  const sourceUpgradePrompt = createSourceUpgradePromptGenerator({
    getContext: () => ({
      currentVersion: APP_VERSION,
      platform: process.platform,
      runtimeDirectory: path.resolve(import.meta.dir, "..", ".."),
      dataDirectory: path.resolve(store.dataDir),
      host: hostname,
      port: server.port!,
    }),
  })
  const agent = new AgentCoordinator({
    store,
    getEnvironment: getAgentEnvironment,
    getCodexTransport: () => appSettings.getSnapshot().codexTransport,
    getCodexApiTransport,
    generateTitle: (messageContent, cwd) => generateTitleForChatDetailed(
      messageContent,
      cwd,
      new QuickResponseAdapter({ getEnvironment: getAgentEnvironment, getCodexApiTransport }),
    ),
    onStateChange: (chatId?: string, options?: { immediate?: boolean }) => {
      if (chatId) {
        if (options?.immediate) {
          void router.broadcastChatStateImmediately(chatId)
          return
        }
        router.scheduleChatStateBroadcast(chatId)
        return
      }
      router.scheduleBroadcast()
    },
  })
  const localHtmlPreviews = createLocalHtmlPreviewManager()
  const previewFiles = new PreviewFiles(id => store.getProject(id)?.localPath)
  const previewTargets = new PreviewTargets(path.join(store.dataDir, "preview-targets.json"), (address, owner) => localHtmlPreviews.resolveFile(address, owner), target => previewFiles.authorize(target))
  const previewBrowser = new PreviewBrowser({
    blockedPorts: protectedPreviewPorts,
    resolveFile: async (target, owner) => {
      if (target.kind === "host-html") {
        if (!target.filePath) return localHtmlPreviews.resolveFile(target.address, owner)
        const file = await realpath(target.filePath)
        if (!isWithinPreviewDirectory(path.dirname(target.filePath), file)) throw new Error("Outside HTML preview folder")
        return file
      }
      if (target.kind !== "project-file" || !/\.html?$/iu.test(target.filePath)) throw new Error("Unsupported preview file")
      const project = store.getProject(target.projectId)
      if (!project) throw new Error("Workspace unavailable")
      const root = await realpath(project.localPath)
      const file = await realpath(path.resolve(root, target.filePath))
      if (!isWithinPreviewDirectory(root, file)) throw new Error("Outside workspace")
      return file
    },
  })
  providerCliUpdates = new ProviderCliUpdates({
    ...options.providerCliUpdates,
    getEnvironment: async () => { await cliEnvironment.refresh(); return getUpdateEnvironment() },
    reserve: async () => {
      if (terminals.hasRunningSessions() || codexModelPolicy.busy || claudeModelPolicy.busy) throw new Error("Close running terminals and wait for model discovery before updating the CLI.")
      return agent.reserveCliUpdate()
    },
  })
  const workspaceAvatars = new WorkspaceAvatarsManager(store.dataDir)
  const previewResources = new PreviewResources(LOCAL_PREVIEW_ASSET_PREFIX)
  router = createWsRouter({
    store,
    agent,
    terminals,
    keybindings,
    appSettings,
    codexModelPolicy,
    claudeModelPolicy,
    agentNetwork: {
      readStatus: () => getAgentNetworkStatus(appSettings.getSnapshot().network),
      detect: detectSystemProxy,
      testConnection: (provider) => testAgentNetworkConnection({
        provider,
        settings: appSettings.getSnapshot().network,
      }),
    },
    subscriptionUsage: {
      read: async () => { await cliEnvironment.refresh(); return readSubscriptionUsageSnapshot({ environment: getAgentEnvironment() }) },
    },
    sourceUpgradePrompt,
    remoteOperations,
    managedUpdate: createManagedUpdateApi(path.resolve(import.meta.dir, "..", "..")),
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    isDiscoveryInProgress: () => discoveryRefresh !== null,
    machineDisplayName: () => appSettings.getSnapshot().machineName,
    getBrowserPreviewBlockedPorts: () => [...protectedPreviewPorts()],
  })
  const staleEmptyChatPruneInterval = setInterval(() => {
    void router.pruneStaleEmptyChats()
      .then(() => router.broadcastSnapshots())
  }, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")
  const pendingServerOperations = new Set<Promise<void>>()
  const serverOperationAbortController = new AbortController()
  let shuttingDown = false

  function trackServerOperation<T>(operation: Promise<T>) {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    )
    pendingServerOperations.add(settled)
    void settled.finally(() => {
      pendingServerOperations.delete(settled)
    })
    return operation
  }

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port
  const managedUpdate = createManagedAppControl({
    instance: process.env.STILLON_UPDATE_INSTANCE,
    secret: process.env.STILLON_UPDATE_SECRET,
    verifying: process.env.STILLON_UPDATE_VERIFYING === "1",
    busy: () => agent.hasActiveWork() || terminals.hasRunningSessions() || pendingServerOperations.size > 0 || codexModelPolicy.busy || claudeModelPolicy.busy || providerCliUpdates.busy,
    shutdown: async () => { await shutdown(); process.emit("SIGTERM") },
  })

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        maxRequestBodySize: MAX_REQUEST_BODY_SIZE_BYTES,
        // Keep local previews and reverse-proxy WebSocket connections alive.
        idleTimeout: 120,
        async fetch(req, serverInstance) {
          const requestStartedAt = performance.now()
          if (shuttingDown) {
            return new Response("Server is shutting down", {
              status: 503,
              headers: { Connection: "close" },
            })
          }

          return trackServerOperation((async () => {
            const url = new URL(req.url)
            const ingress = validateIngress(req, { port: serverInstance.port!, hostname, peer: serverInstance.requestIP(req)?.address, secret: localSecret, allowedOrigins })
            if (ingress instanceof Response) return ingress
            if (url.pathname.startsWith(LOCAL_PREVIEW_ASSET_PREFIX)) {
              const resource = ["GET", "HEAD"].includes(req.method) ? previewResources.resolve(url.pathname) : null
              if (!resource) return new Response("Preview expired or unavailable", { status: 403 })
              const target = new URL(resource.path, url)
              target.searchParams.set("preview-root", resource.context.directory)
              const response = resource.context.projectId ? await handleProjectFilePreview(req, target, store)
                : await localHtmlPreviews.handleRequest(req, target, { allowCreate: false })
              return response ? previewResources.wrap(response, req, resource.context, resource.filePath) : new Response(null, { status: 404 })
            }
            if (url.pathname.startsWith("/api/connect-local/")) {
              const connectResponse = await handleConnectLocal(req, ingress, connector)
              if (connectResponse) return connectResponse
            }
            if (url.pathname.startsWith("/api/connect-operations/")) {
              if (ingress.kind !== "remote" || req.method !== "GET") return new Response("Forbidden", { status: 403 })
              try { const operation = remoteOperations.get(ingress.ownerId, url.pathname.slice("/api/connect-operations/".length)); return Response.json(operation ?? { state: "not-received" }, { headers: { "Cache-Control": "no-store" } }) }
              catch { return Response.json({ error: "OPERATION_EXPIRED" }, { status: 410, headers: { "Cache-Control": "no-store" } }) }
            }
            const updateResponse = managedUpdate.handle(req, serverInstance.requestIP(req)?.address)
            if (updateResponse) return updateResponse
            if (managedUpdate.paused && (url.pathname === "/ws" || !["GET", "HEAD"].includes(req.method))) {
              return new Response("StillOn is finishing an update. Reconnect shortly.", { status: 503 })
            }

            if (url.pathname === "/auth/status") {
              return auth
                ? auth.handleStatus(req)
                : Response.json(
                    {
                      enabled: false,
                      authenticated: true,
                      cacheScope: "public",
                    },
                    {
                      headers: {
                        "Cache-Control": "no-store",
                      },
                    },
                  )
            }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return new Response(null, { status: 405, headers: { Allow: "POST" } })
            }

            previewResources.clear()
            previewFiles.clear()
            await previewBrowser.closeScope("local")
            return auth
              ? auth.handleLogout(req)
              : Response.json({ ok: true })
          }

          if (auth && ingress.kind !== "remote") {
            if (url.pathname === "/auth/login") {
              if (req.method === "GET") {
                return auth.redirectToApp(req)
              }
              if (req.method === "POST") {
                return auth.handleLogin(req, "/")
              }
              return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
            }

            if (url.pathname === "/ws") {
              if (!auth.validateOrigin(req)) {
                return new Response("Forbidden", { status: 403 })
              }
              if (!auth.isAuthenticated(req)) {
                return new Response("Unauthorized", { status: 401 })
              }
            } else if (url.pathname.startsWith("/api/") && !auth.isAuthenticated(req)) {
              return Response.json({ error: "Unauthorized" }, { status: 401 })
            }
          }

          if (url.pathname === "/ws") {
            const upgraded = serverInstance.upgrade(req, {
              data: {
                chunkTransport: url.searchParams.get(SOCKET_TRANSPORT_QUERY) === "1",
                canOpenHostFiles: ingress.kind === "local",
                subscriptions: new Map(),
                snapshotSignatures: new Map(),
                ...(ingress.kind === "remote" ? { remoteOwnerId: ingress.ownerId } : {}),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          if (url.pathname === "/api/sidebar-view") {
            if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } })
            const settings = appSettings.getSnapshot()
            return Response.json({
              machineName: settings.machineName,
              workspaceCollapsed: settings.workspaceCollapsed,
              workspaceCollapseVersions: settings.workspaceCollapseVersions,
            }, { headers: { "Cache-Control": "no-store" } })
          }

          if (url.pathname === "/health") {
            return Response.json({ ok: true, port: actualPort,
              ...(url.searchParams.get("update-setup") === "1" ? { managedUpdateProtocol: 1,
                runtimeProfile: getRuntimeProfile(),
                busy: agent.hasActiveWork() || terminals.hasRunningSessions() || pendingServerOperations.size > 0 || codexModelPolicy.busy || claudeModelPolicy.busy || providerCliUpdates.busy } : {}),
              ...(managedUpdate.instance ? { updateInstance: managedUpdate.instance, updateProtocol: 1, version: APP_VERSION } : {}),
            })
          }

          if (["/api/claude/model-policy", "/api/claude/model-policy/discover", "/api/claude/model-policy/apply"].includes(url.pathname)) {
            const reading = url.pathname === "/api/claude/model-policy"
            const method = reading ? "GET" : "POST"
            if (req.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
            // validateIngress has already checked the remote owner and signed adapter identity.
            if (!reading && ingress.kind !== "remote" && (auth ? !auth.validateOrigin(req)
              : req.headers.has("origin") && req.headers.get("origin") !== url.origin)) {
              await req.arrayBuffer().catch(() => undefined)
              return Response.json({ error: "Forbidden" }, { status: 403 })
            }
            try {
              const result = reading ? claudeModelPolicy.getSnapshot()
                : url.pathname.endsWith("/discover") ? await claudeModelPolicy.discover()
                  : await claudeModelPolicy.apply(await req.json())
              return Response.json(result, { headers: { "Cache-Control": "no-store" } })
            } catch (error) {
              return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { "Cache-Control": "no-store" } })
            }
          }

          if (["/api/codex/model-policy", "/api/codex/model-policy/refresh", "/api/codex/model-policy/restore", "/api/codex/model-policy/discover", "/api/codex/model-policy/apply"].includes(url.pathname)) {
            const reading = url.pathname === "/api/codex/model-policy"
            const method = reading ? "GET" : "POST"
            if (req.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
            if (!reading && (auth ? !auth.validateOrigin(req)
              : req.headers.has("origin") && req.headers.get("origin") !== url.origin)) {
              return Response.json({ error: "Forbidden" }, { status: 403 })
            }
            try {
              const snapshot = reading ? codexModelPolicy.getSnapshot()
                : url.pathname.endsWith("/discover") ? await codexModelPolicy.discover()
                  : url.pathname.endsWith("/apply") ? await codexModelPolicy.applySelection(await req.json())
                  : url.pathname.endsWith("/refresh") ? await codexModelPolicy.refresh()
                  : await codexModelPolicy.restore((await req.json()).target)
              return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } })
            } catch (error) {
              return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
            }
          }

          const cliUpdateResponse = await handleProviderCliUpdates(req, url, providerCliUpdates,
            request => request.headers.has("origin") && (!auth || auth.validateOrigin(request)))
          if (cliUpdateResponse) return cliUpdateResponse
          if (providerCliUpdates.busy && req.method === "POST" && url.pathname.startsWith("/api/provider-setup/")) {
            await req.arrayBuffer().catch(() => undefined)
            return Response.json({ error: "Wait for the CLI update to finish before changing provider setup." }, { status: 409 })
          }
          const providerSetupResponse = await handleProviderSetupRequest(req, url, {
            local: ingress.kind === "local", setup: providerSetup, settings: providerCliSettings,
            validateOrigin: request => auth ? auth.validateOrigin(request) : request.headers.get("origin") === url.origin,
          })
          if (providerSetupResponse) return providerSetupResponse

          const avatarsResponse = await handleWorkspaceAvatars(req, workspaceAvatars, {
            workspaceExists: id => Boolean(store.getProject(id)),
            // Ingress already validated the browser origin against the declared
            // origins. An HTTPS proxy legitimately uses an HTTP upstream URL.
            validateOrigin: request => Boolean(request.headers.get("origin")) && (!auth || auth.validateOrigin(request)),
          })
          if (avatarsResponse) return avatarsResponse
          const appearanceResponse = await handleAppearanceRequest(req, url, {
            dataDir: store.dataDir,
            getAppearance: () => appSettings.getSnapshot().appearance,
            // Ingress has already checked the declared browser origin, including
            // HTTPS proxies and authenticated Connect requests.
            validateOrigin: request => Boolean(request.headers.get("origin")) && (!auth || auth.validateOrigin(request)),
          })
          if (appearanceResponse) return appearanceResponse

          const previewOwner = ingress.kind === "remote" ? ingress.ownerId : "local"
          if ((url.pathname.startsWith("/api/preview-targets") || url.pathname.startsWith("/api/preview-browser") || url.pathname.startsWith("/api/file-previews")) && ingress.kind === "external" && !auth) {
            return Response.json({ error: "Preview access requires local access, Connect or application authentication." }, { status: 403 })
          }
          if (url.pathname.startsWith("/api/preview-browser") && ingress.kind === "remote"
            && (!req.headers.get(REMOTE_SESSION_HEADER) || !req.headers.get(REMOTE_EXPIRY_HEADER))) {
            return Response.json({ error: "Update the StillOn remote adapter before using isolated previews." }, { status: 409 })
          }
          const previewScope = ingress.kind === "remote" ? previewOwner + ":" + req.headers.get(REMOTE_SESSION_HEADER) : "local"
          const targetResponse = await previewTargets.handle(req, url, previewOwner, id => Boolean(store.getProject(id)), id => store.getProject(id)?.localPath)
          if (targetResponse) return targetResponse
          if (url.pathname === "/api/link-capabilities" && req.method === "GET") return Response.json({
            local: ingress.kind === "local", isMac: process.platform === "darwin", filePreviewProtocol: FILE_PREVIEW_PROTOCOL,
          }, { headers: { "Cache-Control": "no-store" } })
          const fileRequest = /^\/api\/(?:preview-targets|file-previews)\/([\w-]{32})\/(content|action|entry|resource|link)(\/.*)?$/u.exec(url.pathname)
          if (fileRequest) {
            // A rejected POST must not leave unread bytes on a reused frp stream.
            // Read once even when authorization prevents parsing or execution.
            const payload = req.method === "POST" ? await req.text().catch(() => undefined) : undefined
            const entry = previewTargets.get(fileRequest[1]!, previewOwner)
            if (!entry) return Response.json({ error: "File authorization expired. Reopen the original link." }, { status: 410 })
            const operation = fileRequest[2]
            if (operation === "link" && req.method === "POST") {
              try {
                const body = JSON.parse(payload ?? "")
                if (typeof body?.address !== "string") return Response.json({ error: "Invalid file link." }, { status: 400 })
                const linked = await previewFiles.linkedAddress(entry.target, body.address, entry.projectId)
                const registration = new Request(new URL("/api/preview-targets", url), { method: "POST", body: JSON.stringify({ address: linked.address, projectId: entry.projectId }) })
                const result = await previewTargets.handle(registration, new URL(registration.url), previewOwner, id => Boolean(store.getProject(id)), undefined, linked.directory)
                if (!result?.ok) return result ?? new Response("Link unavailable", { status: 403 })
                return Response.json({ address: linked.address })
              } catch (error) { return Response.json({ error: (error as Error).message }, { status: error instanceof FileAccessError ? error.status : 403 }) }
            }
            if (operation === "content" && ["GET", "HEAD"].includes(req.method)) return previewFiles.content(req, entry.target, url.searchParams.get("download") === "1")
            if (operation === "action" && req.method === "POST") {
              if (ingress.kind !== "local") return Response.json({ error: "Host actions are available only on this computer." }, { status: 403 })
              try { await previewFiles.action(entry.target, JSON.parse(payload ?? "").action); return Response.json({ ok: true }) }
              catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }) }
            }
            if (operation === "entry" && req.method === "POST") {
              if (ingress.kind === "external") return Response.json({ error: "Direct HTML file previews require loopback access or an updated Connect gateway with an isolated file origin." }, { status: 409 })
              try {
                const file = await previewFiles.resolve(entry.target)
                if (!/\.html?$/iu.test(file)) return Response.json({ error: "An HTML document is required." }, { status: 415 })
                if (ingress.kind === "remote") return Response.json({ protocol: FILE_PREVIEW_PROTOCOL, path: previewFiles.entryPath(entry.target, file), scopeKey: previewFiles.scopeKey(file, previewFiles.directory(entry.target, file)) })
                const previewUrl = await previewFiles.localEntry(entry.target, previewOwner, url.origin, () => !shuttingDown && (!auth || auth.isAuthenticated(req)))
                return Response.json({ protocol: FILE_PREVIEW_PROTOCOL, url: previewUrl })
              } catch (error) { return Response.json({ error: (error as Error).message }, { status: error instanceof FileAccessError ? error.status : 403 }) }
            }
            if (operation === "resource" && ingress.kind === "remote") {
              try { const file = await previewFiles.resolve(entry.target); if (!/\.html?$/iu.test(file)) return new Response("Only HTML documents authorize a resource directory.", { status: 403 }); return previewFiles.resource(req, previewFiles.directory(entry.target, file), fileRequest[3] ?? "/", url.origin) }
              catch (error) { return Response.json({ error: (error as Error).message }, { status: 403 }) }
            }
            return new Response("Method not allowed", { status: 405 })
          }
          const previewBrowserResponse = await previewBrowser.handle(req, url, { owner: previewOwner, scope: previewScope,
            expiresAt: ingress.kind === "remote" ? Number(req.headers.get(REMOTE_EXPIRY_HEADER)) : undefined,
            target: id => previewTargets.get(id, previewOwner) })
          if (previewBrowserResponse) return previewBrowserResponse

          const browserPreviewProxyResponse = await handleBrowserPreviewProxy(req, url, {
            blockedPorts: [actualPort],
            signal: serverOperationAbortController.signal,
          })
          if (browserPreviewProxyResponse) {
            return browserPreviewProxyResponse
          }

          const uploadResponse = await handleProjectUpload(req, url, store, { maxUploadSizeBytes })
          if (uploadResponse) {
            return uploadResponse
          }

          const deleteUploadResponse = await handleProjectUploadDelete(req, url, store)
          if (deleteUploadResponse) {
            return deleteUploadResponse
          }

          const attachmentContentResponse = await handleAttachmentContent(req, url, store)
          if (attachmentContentResponse) {
            return attachmentContentResponse
          }

          const projectFilePreviewResponse = await handleProjectFilePreview(req, url, store)
          if (projectFilePreviewResponse) {
            const target = projectPreviewTarget(url.pathname)
            if (ingress.kind !== "remote" && target && projectFilePreviewResponse.ok
              && projectFilePreviewResponse.headers.get("content-type")?.includes("text/html")) {
              return previewResources.wrap(projectFilePreviewResponse, req, previewResources.create(target.projectId, target.filePath), target.filePath)
            }
            return projectFilePreviewResponse
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store)
          if (projectFileContentResponse) {
            return projectFileContentResponse
          }

          const localHtmlPreviewResponse = await localHtmlPreviews.handleRequest(req, url, {
            allowCreate: Boolean(auth) || isLoopbackBindHost(url.hostname),
            owner: previewOwner,
          })
          if (localHtmlPreviewResponse) {
            const target = localHtmlPreviewTarget(url.pathname)
            if (ingress.kind !== "remote" && target && localHtmlPreviewResponse.ok && localHtmlPreviewResponse.headers.get("content-type")?.includes("text/html")) {
              return previewResources.wrap(localHtmlPreviewResponse, req, previewResources.createLocalHtml(target.prefix, target.filePath), target.filePath)
            }
            return localHtmlPreviewResponse
          }

          const localFileContentResponse = await handleLocalFileContent(req, url, {
            allowRead: Boolean(auth) || isLoopbackBindHost(url.hostname),
          })
          if (localFileContentResponse) {
            return localFileContentResponse
          }

          return serveStaticAsset(distDir, req, url.pathname)
          })()).then(response => appendHttpTiming(response, "host", requestStartedAt))
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            if (shuttingDown) return
            if (managedUpdate.paused) { ws.close(1012, "StillOn is updating"); return }
            void trackServerOperation(router.handleMessage(ws, raw))
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      })
      actualPort = server.port!
      protectPreviewPort(actualPort)
      break
    } catch (err: unknown) {
      const isAddrInUse =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (!isAddrInUse || strictPort || attempt === MAX_PORT_ATTEMPTS - 1) {
        throw err
      }
      console.log(`Port ${actualPort} is in use, trying ${actualPort + 1}...`)
      actualPort++
    }
  }

  connector = await createConnector({ ...options.connect, origin: options.connect?.origin ?? process.env.STILLON_CONNECT_ORIGIN,
    dataDir: store.dataDir, localSecret, targetOrigin: `http://${hostname === "::" ? "[::1]" : hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${actualPort}`,
    name: () => appSettings.getSnapshot().machineName })

  // Binding the server is the startup critical path. Provider history is
  // discovered incrementally afterwards, while saved sidebar projects are
  // already available to the first connected client.
  const backgroundDiscoveryTimer = setTimeout(() => {
    void refreshDiscovery()
  }, BACKGROUND_PROJECT_DISCOVERY_DELAY_MS)

  let shutdownPromise: Promise<void> | null = null
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise

    shutdownPromise = (async () => {
      shuttingDown = true
      clearTimeout(backgroundDiscoveryTimer)
      clearInterval(staleEmptyChatPruneInterval)
      discoveryAbortController.abort()
      serverOperationAbortController.abort()
      forceDiscoveryRefreshPending = false
      await connector?.stop()
      await previewBrowser.close()
      await previewFiles.close()

      // Stop new network work first, then let handlers that already entered
      // the server unwind before compacting EventStore or returning to callers
      // that may remove the data directory.
      await stopConnectListener(server)
      await codexModelPolicy.close()
      await claudeModelPolicy.close()
      await Promise.allSettled([...pendingServerOperations])
      await providerCliUpdates.close()
      await discoveryRefresh
      // Stop every run and wait for its processes, so none outlives the service.
      await agent.shutdown()
      router.dispose()
      remoteOperations.close()
      localHtmlPreviews.dispose()
      previewTargets.clear()
      releasePreviewPort(actualPort)
      previewResources.clear()
      appSettings.dispose()
      keybindings.dispose()
      terminals.closeAll()
      await store.compact()
    })()

    return shutdownPromise
  }

  return {
    port: actualPort,
    store,
    stop: shutdown,
  }
}

async function handleProjectUpload(
  req: Request,
  url: URL,
  store: EventStore,
  limits: { maxUploadSizeBytes: number }
) {
  if (req.method !== "POST") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Workspace not found" }, { status: 404 })
  }

  const formData = await req.formData()
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return Response.json({ error: "No files uploaded" }, { status: 400 })
  }

  if (files.length > MAX_UPLOAD_FILES) {
    return Response.json({ error: `You can upload up to ${MAX_UPLOAD_FILES} files at a time.` }, { status: 400 })
  }

  for (const file of files) {
    if (file.size > limits.maxUploadSizeBytes) {
      return Response.json(
        { error: `File "${file.name}" exceeds the ${Math.floor(limits.maxUploadSizeBytes / (1024 * 1024))} MB limit.` },
        { status: 413 }
      )
    }
  }

  const totalUploadSize = files.reduce((total, file) => total + file.size, 0)
  if (totalUploadSize > limits.maxUploadSizeBytes) {
    return Response.json(
      { error: `Combined uploads exceed the ${Math.floor(limits.maxUploadSizeBytes / (1024 * 1024))} MB limit.` },
      { status: 413 },
    )
  }

  try {
    const attachments = await persistUploadedFiles({
      projectId: project.id,
      localPath: project.localPath,
      files,
    })
    return Response.json({ attachments })
  } catch (error) {
    console.error("[uploads] Upload failed:", error)
    return Response.json({ error: "Upload failed" }, { status: 500 })
  }
}

async function handleAttachmentContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Workspace not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const filePath = await resolveProjectUploadFilePath(project.localPath, storedName)
  if (!filePath) {
    return Response.json({ error: "Attachment not found" }, { status: 404 })
  }
  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "Attachment not found" }, { status: 404 })
    }
  } catch {
    return Response.json({ error: "Attachment not found" }, { status: 404 })
  }

  const headers = new Headers({
    "Content-Type": inferAttachmentContentType(storedName, file.type),
  })
  applyDownloadHeader(headers, storedName, url)

  return new Response(file, { headers })
}

async function resolveProjectFileFromUrl(store: EventStore, projectId: string, rawRelativePath: string) {
  const project = store.getProject(projectId)
  if (!project) {
    return { error: Response.json({ error: "Workspace not found" }, { status: 404 }) }
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawRelativePath)
  } catch {
    return { error: Response.json({ error: "Invalid project file path" }, { status: 400 }) }
  }

  const relativePath = path.posix.normalize(decodedPath.replaceAll("\\", "/"))
  if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../") || path.posix.isAbsolute(relativePath)) {
    return { error: Response.json({ error: "Invalid project file path" }, { status: 400 }) }
  }

  const filePath = path.resolve(project.localPath, relativePath)
  const projectRoot = path.resolve(project.localPath)
  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${path.sep}`)) {
    return { error: Response.json({ error: "Invalid project file path" }, { status: 400 }) }
  }

  let canonicalProjectRoot: string
  let canonicalFilePath: string
  try {
    [canonicalProjectRoot, canonicalFilePath] = await Promise.all([
      realpath(projectRoot),
      realpath(filePath),
    ])
  } catch {
    return { error: Response.json({ error: "File not found" }, { status: 404 }) }
  }

  const canonicalRelativePath = path.relative(canonicalProjectRoot, canonicalFilePath)
  if (
    canonicalRelativePath === ".."
    || canonicalRelativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(canonicalRelativePath)
  ) {
    return { error: Response.json({ error: "Project file path escapes the project root" }, { status: 403 }) }
  }

  return { project, relativePath, filePath: canonicalFilePath }
}

async function readProjectFile(projectFilePath: string) {
  const file = Bun.file(projectFilePath)
  try {
    const info = await stat(projectFilePath)
    if (!info.isFile()) {
      return { error: Response.json({ error: "File not found" }, { status: 404 }) }
    }
  } catch {
    return { error: Response.json({ error: "File not found" }, { status: 404 }) }
  }

  return { file }
}

async function handleProjectFilePreview(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview\/(.+)$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
      },
    })
  }

  const resolved = await resolveProjectFileFromUrl(store, match[1], match[2])
  if ("error" in resolved) return resolved.error

  const previewRoot = url.searchParams.get("preview-root")
  if (previewRoot !== null) {
    try {
      const root = await realpath(path.resolve(resolved.project.localPath, previewRoot))
      const projectRoot = await realpath(resolved.project.localPath)
      const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)) }
      if (!within(projectRoot, root) || !within(root, resolved.filePath)) return new Response("Outside preview folder", { status: 403 })
    } catch { return new Response("Preview folder unavailable", { status: 404 }) }
  }

  const readResult = await readProjectFile(resolved.filePath)
  if ("error" in readResult) return readResult.error

  const body = req.method === "HEAD"
    ? null
    : isRewritableProjectPreviewFile(resolved.relativePath)
      ? rewriteRootRelativeReferences(
          await readResult.file.text(),
          `/api/projects/${match[1]}/preview`,
        )
      : readResult.file

  return new Response(body, {
    headers: getProjectFilePreviewHeaders(resolved.relativePath, readResult.file.type),
  })
}

async function handleProjectFileContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
      },
    })
  }

  const resolved = await resolveProjectFileFromUrl(store, match[1], match[2])
  if ("error" in resolved) return resolved.error

  const readResult = await readProjectFile(resolved.filePath)
  if ("error" in readResult) return readResult.error

  const headers = new Headers({
    "Content-Type": inferProjectFileContentType(resolved.relativePath, readResult.file.type),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  applyDownloadHeader(headers, path.basename(resolved.relativePath), url)

  return new Response(req.method === "HEAD" ? null : readResult.file, { headers })
}

async function handleLocalFileContent(req: Request, url: URL, options: { allowRead: boolean }) {
  if (!url.pathname.startsWith("/api/local-files/content/")) {
    return null
  }

  const target = parseLocalFileContentUrl(url.pathname)
  if (!target) {
    return Response.json({ error: "Invalid local Markdown content path" }, { status: 400 })
  }

  if (!options.allowRead) {
    return Response.json(
      { error: "Project-external Markdown previews require password protection during remote access." },
      { status: 403 },
    )
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const readResult = await readProjectFile(target.filePath)
  if ("error" in readResult) return readResult.error

  const headers = new Headers({
    "Content-Type": inferProjectFileContentType(target.filePath, readResult.file.type),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  if (path.extname(target.filePath).toLowerCase() === ".svg") {
    headers.set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
  }
  applyDownloadHeader(headers, path.basename(target.filePath), url)

  return new Response(readResult.file, { headers })
}

function applyDownloadHeader(headers: Headers, fileName: string, url: URL) {
  if (url.searchParams.get("download") !== "1") return
  headers.set("Content-Disposition", buildAttachmentContentDisposition(fileName))
}

function buildAttachmentContentDisposition(fileName: string) {
  // Keep the legacy filename ASCII; filename* carries the original UTF-8 name.
  const fallbackName = path.basename(fileName).replaceAll("\\", "-").replace(/[^\x20-\x7e]|"/g, "_") || "download"
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeRfc5987ValueChars(fileName)}`
}

function encodeRfc5987ValueChars(value: string) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function getProjectFilePreviewHeaders(relativePath: string, fallbackType?: string) {
  const headers = new Headers({
    "Content-Type": inferProjectFilePreviewContentType(relativePath, fallbackType),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })

  if (isHtmlFile(relativePath)) {
    headers.set(
      "Content-Security-Policy",
      "sandbox allow-downloads allow-forms allow-modals allow-popups allow-scripts"
    )
  } else if (path.extname(relativePath).toLowerCase() === ".svg") {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
  }

  return headers
}

function inferProjectFilePreviewContentType(fileName: string, fallbackType?: string) {
  const extension = path.extname(fileName).toLowerCase()
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8"
    default:
      if (isProjectTextPreviewPath(fileName)) {
        return extension === ".json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8"
      }
      return inferProjectFileContentType(fileName, fallbackType)
  }
}

function isHtmlFile(fileName: string) {
  const extension = path.extname(fileName).toLowerCase()
  return extension === ".html" || extension === ".htm"
}

function isRewritableProjectPreviewFile(fileName: string) {
  const extension = path.extname(fileName).toLowerCase()
  return extension === ".html"
    || extension === ".htm"
    || extension === ".css"
    || extension === ".js"
    || extension === ".mjs"
    || extension === ".cjs"
}

async function handleProjectUploadDelete(req: Request, url: URL, store: EventStore) {
  if (req.method !== "DELETE") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Workspace not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const deleted = await deleteProjectUpload({
    localPath: project.localPath,
    storedName,
  })

  return Response.json({ ok: deleted })
}
