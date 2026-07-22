import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { APP_NAME, LOG_PREFIX } from "../shared/branding"
import { parseLocalFileContentUrl } from "../shared/local-file-urls"
import type { ChatAttachment } from "../shared/types"
import { createAuthManager } from "./auth"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { AppSettingsManager } from "./app-settings"
import { getAgentNetworkStatus, mergeAgentNetworkEnvironment } from "./agent-environment"
import { detectSystemProxy, testAgentNetworkConnection } from "./agent-network"
import { DiffStore } from "./diff-store"
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
import { handleBrowserPreviewProxy, rewriteRootRelativeReferences } from "./browser-preview-proxy"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { resolveProjectUploadFilePath } from "./paths"
import { migrateLegacyBrandDataRoot } from "./brand-migration"
import { createLocalHtmlPreviewManager, isLoopbackBindHost } from "./local-html-preview"
import { generateTitleForChatDetailed } from "./generate-title"
import { generateCommitMessageDetailed } from "./generate-commit-message"
import { QuickResponseAdapter } from "./quick-response"
import { readSubscriptionUsageSnapshot } from "./subscription-usage"

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
  if (!options.dataDir) {
    const migration = await migrateLegacyBrandDataRoot()
    if (migration.status === "migrated") {
      console.log(`${LOG_PREFIX} moved existing data from ${migration.from} to ${migration.to}`)
    }
  }
  const store = new EventStore(options.dataDir)
  const machineDisplayName = getMachineDisplayName()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"), {
    defaultMachineName: machineDisplayName,
  })
  const getAgentEnvironment = () => mergeAgentNetworkEnvironment(process.env, appSettings.getSnapshot().network)
  const diffStore = new DiffStore(store.dataDir, {
    generateCommitMessage: (args) => generateCommitMessageDetailed(
      args,
      new QuickResponseAdapter({ getEnvironment: getAgentEnvironment }),
    ),
  })
  await store.initialize()
  await diffStore.initialize()
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
      undefined,
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
  const agent = new AgentCoordinator({
    store,
    getEnvironment: getAgentEnvironment,
    generateTitle: (messageContent, cwd) => generateTitleForChatDetailed(
      messageContent,
      cwd,
      new QuickResponseAdapter({ getEnvironment: getAgentEnvironment }),
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
  router = createWsRouter({
    store,
    diffStore,
    agent,
    terminals,
    keybindings,
    appSettings,
    agentNetwork: {
      readStatus: () => getAgentNetworkStatus(appSettings.getSnapshot().network),
      detect: detectSystemProxy,
      testConnection: (provider) => testAgentNetworkConnection({
        provider,
        settings: appSettings.getSnapshot().network,
      }),
    },
    subscriptionUsage: {
      read: () => readSubscriptionUsageSnapshot({ environment: getAgentEnvironment() }),
    },
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    isDiscoveryInProgress: () => discoveryRefresh !== null,
    machineDisplayName: () => appSettings.getSnapshot().machineName,
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

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        maxRequestBodySize: MAX_REQUEST_BODY_SIZE_BYTES,
        // Keep local previews and reverse-proxy WebSocket connections alive.
        idleTimeout: 120,
        async fetch(req, serverInstance) {
          if (shuttingDown) {
            return new Response("Server is shutting down", {
              status: 503,
              headers: { Connection: "close" },
            })
          }

          return trackServerOperation((async () => {
            const url = new URL(req.url)

            if (url.pathname === "/auth/status") {
              return auth
                ? auth.handleStatus(req)
                : Response.json({ enabled: false, authenticated: true })
            }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return new Response(null, { status: 405, headers: { Allow: "POST" } })
            }

            return auth
              ? auth.handleLogout(req)
              : Response.json({ ok: true })
          }

          if (auth) {
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
                subscriptions: new Map(),
                snapshotSignatures: new Map(),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          if (url.pathname === "/health") {
            return Response.json({ ok: true, port: actualPort })
          }

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
            return projectFilePreviewResponse
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store)
          if (projectFileContentResponse) {
            return projectFileContentResponse
          }

          const localHtmlPreviewResponse = await localHtmlPreviews.handleRequest(req, url, {
            allowCreate: Boolean(auth) || isLoopbackBindHost(url.hostname),
          })
          if (localHtmlPreviewResponse) {
            return localHtmlPreviewResponse
          }

          const localFileContentResponse = await handleLocalFileContent(req, url, {
            allowRead: Boolean(auth) || isLoopbackBindHost(url.hostname),
          })
          if (localFileContentResponse) {
            return localFileContentResponse
          }

            return serveStatic(distDir, url.pathname)
          })())
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            if (shuttingDown) return
            void trackServerOperation(router.handleMessage(ws, raw))
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      })
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

      // Stop new network work first, then let handlers that already entered
      // the server unwind before compacting EventStore or returning to callers
      // that may remove the data directory.
      await server.stop(true)
      await Promise.allSettled([...pendingServerOperations])
      await discoveryRefresh
      for (const chatId of [...agent.activeTurns.keys()]) {
        await agent.cancel(chatId)
      }
      router.dispose()
      localHtmlPreviews.dispose()
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
    diffStore,
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
    return Response.json({ error: "Project not found" }, { status: 404 })
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
    return Response.json({ error: "Project not found" }, { status: 404 })
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
    return { error: Response.json({ error: "Project not found" }, { status: 404 }) }
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
  const fallbackName = path.basename(fileName).replaceAll("\\", "-").replace(/["\r\n]/g, "_") || "download"
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
    return Response.json({ error: "Project not found" }, { status: 404 })
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

async function serveStatic(distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")

  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file, {
      headers: getStaticHeaders(requestedPath),
    })
  }

  const indexFile = Bun.file(indexPath)
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    })
  }

  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`,
    { status: 503 }
  )
}

function getStaticHeaders(requestedPath: string) {
  if (requestedPath.endsWith(".html")) {
    return {
      "Cache-Control": "no-store",
    }
  }

  return undefined
}
