import path from "node:path"
import { stat } from "node:fs/promises"
import { APP_NAME, APP_VERSION, getRuntimeProfile, LOG_PREFIX } from "../shared/branding"
import { parseLocalFileContentUrl } from "../shared/local-file-urls"
import type { ChatAttachment } from "../shared/types"
import { createAuthManager } from "./auth"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { StillOnAnalyticsReporter } from "./analytics"
import { AppSettingsManager } from "./app-settings"
import { DiffStore } from "./diff-store"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { createWsRouter, type ClientState } from "./ws-router"
import { handleBrowserPreviewProxy } from "./browser-preview-proxy"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { resolveProjectUploadFilePath } from "./paths"
import { migrateLegacyBrandDataRoot } from "./brand-migration"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024
const MAX_REQUEST_BODY_SIZE_BYTES = 110 * 1024 * 1024
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000

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
  onMigrationProgress?: (message: string) => void
}

export async function startStillOnServer(options: StartStillOnServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  const auth = options.password ? createAuthManager(options.password, { trustProxy: options.trustProxy ?? false }) : null
  if (!options.dataDir) {
    const migration = await migrateLegacyBrandDataRoot()
    if (migration.status === "migrated") {
      console.log(`${LOG_PREFIX} moved existing data from ${migration.from} to ${migration.to}`)
    }
  }
  const store = new EventStore(options.dataDir)
  const diffStore = new DiffStore(store.dataDir)
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  await diffStore.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = discoverProjects()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"), {
    defaultMachineName: machineDisplayName,
  })
  await appSettings.initialize()
  await keybindings.initialize()
  const analytics = new StillOnAnalyticsReporter({
    settings: appSettings,
    currentVersion: APP_VERSION,
    environment: runtimeProfile === "dev" ? "dev" : "prod",
  })
  const agent = new AgentCoordinator({
    store,
    analytics,
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
  router = createWsRouter({
    store,
    diffStore,
    agent,
    terminals,
    keybindings,
    appSettings,
    analytics,
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName: () => appSettings.getSnapshot().machineName,
  })
  const staleEmptyChatPruneInterval = setInterval(() => {
    void router.pruneStaleEmptyChats()
      .then(() => router.broadcastSnapshots())
  }, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")

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
          })
          if (browserPreviewProxyResponse) {
            return browserPreviewProxyResponse
          }

          const uploadResponse = await handleProjectUpload(req, url, store)
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

          const localFileContentResponse = await handleLocalFileContent(req, url)
          if (localFileContentResponse) {
            return localFileContentResponse
          }

          return serveStatic(distDir, url.pathname)
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            router.handleMessage(ws, raw)
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

  analytics.trackLaunch({
    port: actualPort,
    host: hostname,
    openBrowser: options.openBrowser ?? true,
    password: options.password ?? null,
    strictPort,
  })

  const shutdown = async () => {
    clearInterval(staleEmptyChatPruneInterval)
    for (const chatId of [...agent.activeTurns.keys()]) {
      await agent.cancel(chatId)
    }
    router.dispose()
    appSettings.dispose()
    keybindings.dispose()
    terminals.closeAll()
    await store.compact()
    server.stop(true)
  }

  return {
    port: actualPort,
    store,
    diffStore,
    stop: shutdown,
  }
}

async function handleProjectUpload(req: Request, url: URL, store: EventStore) {
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
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return Response.json(
        { error: `File "${file.name}" exceeds the ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB limit.` },
        { status: 413 }
      )
    }
  }

  const totalUploadSize = files.reduce((total, file) => total + file.size, 0)
  if (totalUploadSize > MAX_UPLOAD_SIZE_BYTES) {
    return Response.json(
      { error: `Combined uploads exceed the ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB limit.` },
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

function resolveProjectFileFromUrl(store: EventStore, projectId: string, rawRelativePath: string) {
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

  return { project, relativePath, filePath }
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

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const resolved = resolveProjectFileFromUrl(store, match[1], match[2])
  if ("error" in resolved) return resolved.error

  const readResult = await readProjectFile(resolved.filePath)
  if ("error" in readResult) return readResult.error

  return new Response(readResult.file, {
    headers: getProjectFilePreviewHeaders(resolved.relativePath, readResult.file.type),
  })
}

async function handleProjectFileContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/)
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

  const resolved = resolveProjectFileFromUrl(store, match[1], match[2])
  if ("error" in resolved) return resolved.error

  const readResult = await readProjectFile(resolved.filePath)
  if ("error" in readResult) return readResult.error

  const headers = new Headers({
    "Content-Type": inferProjectFileContentType(resolved.relativePath, readResult.file.type),
  })
  applyDownloadHeader(headers, path.basename(resolved.relativePath), url)

  return new Response(readResult.file, { headers })
}

async function handleLocalFileContent(req: Request, url: URL) {
  if (!url.pathname.startsWith("/api/local-files/content/")) {
    return null
  }

  const target = parseLocalFileContentUrl(url.pathname)
  if (!target) {
    return Response.json({ error: "Invalid local Markdown file path" }, { status: 400 })
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
  })
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
