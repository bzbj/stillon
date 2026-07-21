import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef, type MouseEvent as ReactMouseEvent } from "react"
import {
  buildLocalFileContentUrl,
  buildLocalMarkdownPreviewUrl,
  isLocalMarkdownPreviewPath,
  normalizeLocalFilePath,
} from "../../../shared/local-file-urls"
import {
  buildProjectFileContentUrl,
  buildProjectFilePreviewUrl,
  buildProjectMarkdownPreviewUrl,
  isProjectMarkdownPreviewPath,
} from "../../../shared/project-file-urls"
import { cn } from "../../lib/utils"
import { appendLocalFileLinkLocation, shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import { requestLocalHtmlPreviewUrl } from "../../lib/localHtmlPreview"
import { createMarkdownComponents, localFileMarkdownUrlTransform } from "../messages/shared"
import { TEXT_PREVIEW_LIMIT_BYTES, fetchTextPreview } from "../messages/attachmentPreview"

type MarkdownPreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string; truncated: boolean }

export type MarkdownPreviewSource =
  | { kind: "project"; projectId: string; filePath: string }
  | { kind: "local"; filePath: string }

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/i

interface MarkdownPreviewPanelProps {
  source: MarkdownPreviewSource
  refreshVersion: number
  zoom: number
  onNavigate: (address: string) => void
  canOpenHostFiles?: boolean
  projectLocalPath?: string | null
  onOpenHostFile?: (filePath: string, action: "open_editor" | "open_default") => void
}

export function MarkdownPreviewPanel({
  source,
  refreshVersion,
  zoom,
  onNavigate,
  canOpenHostFiles = false,
  projectLocalPath,
  onOpenHostFile,
}: MarkdownPreviewPanelProps) {
  const [previewState, setPreviewState] = useState<MarkdownPreviewState>({ status: "loading" })
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const { filePath } = source

  useEffect(() => {
    let cancelled = false
    setPreviewState({ status: "loading" })
    setNavigationError(null)

    void fetchTextPreview(buildMarkdownContentUrl(source), TEXT_PREVIEW_LIMIT_BYTES)
      .then(({ content, truncated }) => {
        if (cancelled) return
        setPreviewState({ status: "ready", content, truncated })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setPreviewState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load Markdown preview.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [filePath, refreshVersion, source])

  const components = useMemo(() => {
    const baseComponents = createMarkdownComponents()
    return {
      ...baseComponents,
      a: ({ children, href, onClick, ...props }: ComponentPropsWithoutRef<"a">) => {
        const linkedPath = resolveMarkdownResourcePath(source, href)
        if (!linkedPath) {
          const isDocumentFragment = href?.startsWith("#") ?? false
          return (
            <a
              className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40"
              href={href}
              target={isDocumentFragment ? undefined : "_blank"}
              rel={isDocumentFragment ? undefined : "noopener noreferrer"}
              onClick={onClick}
              {...props}
            >
              {children}
            </a>
          )
        }

        const location = getMarkdownTargetLocation(href)
        const previewUrl = buildPreviewUrlForLinkedPath(source, linkedPath)
        const locatedPreviewUrl = previewUrl ? appendLocalFileLinkLocation(previewUrl, location) : null
        const isLocalHtmlLink = source.kind === "local" && isHtmlPreviewPath(linkedPath)
        const hostFilePath = getHostFilePath(source, linkedPath, projectLocalPath)
        const shouldOpenOnHost = canOpenHostFiles && Boolean(hostFilePath && onOpenHostFile)
        const shouldDownload = !canOpenHostFiles && source.kind === "project"
        const contentUrl = buildContentUrlForLinkedPath(source, linkedPath, { download: shouldDownload })
        const isUnavailable = !locatedPreviewUrl && !isLocalHtmlLink && !shouldOpenOnHost && !shouldDownload
        const linkUrl = previewUrl ?? contentUrl

        if (isUnavailable) {
          return (
            <span
              className="text-muted-foreground underline decoration-dotted"
              title="This project-external file cannot be downloaded remotely."
            >
              {children}
            </span>
          )
        }

        return (
          <a
            className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40"
            href={locatedPreviewUrl ?? (isLocalHtmlLink || shouldOpenOnHost ? "#" : linkUrl)}
            target={locatedPreviewUrl || isLocalHtmlLink || shouldOpenOnHost || shouldDownload ? undefined : "_blank"}
            rel={locatedPreviewUrl || isLocalHtmlLink || shouldOpenOnHost || shouldDownload ? undefined : "noopener noreferrer"}
            download={shouldDownload ? getFileName(linkedPath) : undefined}
            onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
              onClick?.(event)
              if (event.defaultPrevented) return
              if (locatedPreviewUrl) {
                event.preventDefault()
                onNavigate(locatedPreviewUrl)
                return
              }
              if (isLocalHtmlLink) {
                event.preventDefault()
                setNavigationError(null)
                void requestLocalHtmlPreviewUrl(linkedPath)
                  .then((url) => onNavigate(appendLocalFileLinkLocation(url, location)))
                  .catch((error: unknown) => {
                    setNavigationError(error instanceof Error ? error.message : "Unable to open HTML preview.")
                  })
                return
              }
              if (shouldOpenOnHost && hostFilePath && onOpenHostFile) {
                event.preventDefault()
                onOpenHostFile(
                  hostFilePath,
                  shouldOpenLocalFileLinkInEditor(hostFilePath) ? "open_editor" : "open_default",
                )
              }
            }}
            {...props}
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt, className, ...props }: ComponentPropsWithoutRef<"img">) => {
        const linkedPath = resolveMarkdownResourcePath(source, src)
        const resolvedSrc = linkedPath ? buildContentUrlForLinkedPath(source, linkedPath) : src
        return (
          <img
            src={resolvedSrc}
            alt={alt ?? ""}
            className={cn("max-w-full rounded-md border border-border bg-background", className)}
            {...props}
          />
        )
      },
    }
  }, [canOpenHostFiles, onNavigate, onOpenHostFile, projectLocalPath, source])

  return (
    <div className="h-full w-full overflow-auto bg-background">
      <div
        className="min-h-full origin-top-left"
        style={{
          width: `${100 / zoom}%`,
          transform: `scale(${zoom})`,
        }}
      >
        <div className="mx-auto w-full max-w-[820px] px-5 py-5">
          <div className="mb-5 flex min-w-0 items-center gap-2 border-b border-border pb-3">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={filePath}>
              {filePath}
            </div>
          </div>

          {navigationError ? (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {navigationError}
            </div>
          ) : null}

          {previewState.status === "loading" ? (
            <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              Loading Markdown preview...
            </div>
          ) : previewState.status === "error" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {previewState.message}
            </div>
          ) : (
            <div className="space-y-3">
              {previewState.truncated ? (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Preview truncated to 1024 KB.
                </div>
              ) : null}
              <article className="prose prose-sm max-w-none text-foreground dark:prose-invert">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={components}
                  urlTransform={localFileMarkdownUrlTransform}
                >
                  {previewState.content}
                </Markdown>
              </article>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function buildMarkdownContentUrl(source: MarkdownPreviewSource) {
  return source.kind === "project"
    ? buildProjectFileContentUrl(source.projectId, source.filePath)
    : buildLocalFileContentUrl(source.filePath)
}

function buildPreviewUrlForLinkedPath(source: MarkdownPreviewSource, filePath: string) {
  if (source.kind === "local") {
    return isLocalMarkdownPreviewPath(filePath) ? buildLocalMarkdownPreviewUrl(filePath) : null
  }

  if (isProjectMarkdownPreviewPath(filePath)) {
    return buildProjectMarkdownPreviewUrl(source.projectId, filePath)
  }
  if (isHtmlPreviewPath(filePath)) {
    return buildProjectFilePreviewUrl(source.projectId, filePath)
  }
  return null
}

function buildContentUrlForLinkedPath(
  source: MarkdownPreviewSource,
  filePath: string,
  options: { download?: boolean } = {},
) {
  return source.kind === "project"
    ? buildProjectFileContentUrl(source.projectId, filePath, options)
    : buildLocalFileContentUrl(filePath, options)
}

function isHtmlPreviewPath(filePath: string) {
  const extension = getFileExtension(filePath)
  return extension === ".html" || extension === ".htm"
}

function getFileExtension(filePath: string) {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : ""
}

function getFileName(filePath: string) {
  return filePath.split(/[\\/]/).pop() || "download"
}

function getMarkdownTargetLocation(target: string | undefined | null) {
  if (!target) return {}
  const hashIndex = target.indexOf("#")
  const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined
  const withoutFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target
  const queryIndex = withoutFragment.indexOf("?")
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : undefined
  return { query, fragment }
}

function getHostFilePath(
  source: MarkdownPreviewSource,
  linkedPath: string,
  projectLocalPath: string | null | undefined,
) {
  if (source.kind === "local") return linkedPath
  if (!projectLocalPath) return null
  return `${projectLocalPath.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/${linkedPath}`
}

export function resolveMarkdownResourcePath(source: MarkdownPreviewSource, target: string | undefined | null) {
  if (!target) return null
  const trimmed = target.trim()
  const isWindowsAbsolutePath = WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
  if (
    !trimmed
    || trimmed.startsWith("#")
    || trimmed.startsWith("?")
    || trimmed.startsWith("//")
    || (!isWindowsAbsolutePath && /^[a-z][a-z\d+.-]*:/i.test(trimmed))
  ) {
    return null
  }

  const [rawPath] = trimmed.split(/[?#]/)
  if (!rawPath) return null

  const decodedPath = safeDecodePath(rawPath).replace(/\\/g, "/")
  const baseDir = getFileDirectory(source.filePath)
  if (source.kind === "local") {
    const candidatePath = isAbsoluteLocalPath(decodedPath)
      ? decodedPath
      : `${baseDir ? `${baseDir}/` : ""}${decodedPath}`
    return normalizeAbsoluteLocalPath(candidatePath)
  }

  const candidatePath = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : `${baseDir ? `${baseDir}/` : ""}${decodedPath}`
  return normalizeRelativePath(candidatePath)
}

function getFileDirectory(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index > 0 ? normalized.slice(0, index) : ""
}

function normalizeRelativePath(filePath: string) {
  const parts: string[] = []
  for (const part of filePath.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length > 0 ? parts.join("/") : null
}

function normalizeAbsoluteLocalPath(filePath: string) {
  const normalized = normalizeLocalFilePath(filePath).replace(/\\/g, "/")
  if (/^[a-z]:\//i.test(normalized)) {
    const drive = normalized.slice(0, 2)
    const relativePath = normalizeRelativePath(normalized.slice(3))
    return relativePath ? `${drive}/${relativePath}` : `${drive}/`
  }
  if (!normalized.startsWith("/")) return null
  const relativePath = normalizeRelativePath(normalized.slice(1))
  return relativePath ? `/${relativePath}` : null
}

function isAbsoluteLocalPath(filePath: string) {
  return filePath.startsWith("/") || /^[a-z]:\//i.test(filePath)
}

function safeDecodePath(filePath: string) {
  try {
    return decodeURIComponent(filePath)
  } catch {
    return filePath
  }
}
