import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef, type MouseEvent as ReactMouseEvent } from "react"
import {
  buildLocalFileContentUrl,
  buildLocalMarkdownPreviewUrl,
  isLocalMarkdownPreviewPath,
} from "../../../shared/local-file-urls"
import {
  buildProjectFileContentUrl,
  buildProjectFilePreviewUrl,
  buildProjectMarkdownPreviewUrl,
  isProjectMarkdownPreviewPath,
} from "../../../shared/project-file-urls"
import { cn } from "../../lib/utils"
import { createMarkdownComponents } from "../messages/shared"
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
}

export function MarkdownPreviewPanel({
  source,
  refreshVersion,
  zoom,
  onNavigate,
}: MarkdownPreviewPanelProps) {
  const [previewState, setPreviewState] = useState<MarkdownPreviewState>({ status: "loading" })
  const { filePath } = source

  useEffect(() => {
    let cancelled = false
    setPreviewState({ status: "loading" })

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
          return (
            <a
              className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClick}
              {...props}
            >
              {children}
            </a>
          )
        }

        const previewUrl = buildPreviewUrlForLinkedPath(source, linkedPath)
        const contentUrl = buildContentUrlForLinkedPath(source, linkedPath)
        const linkUrl = previewUrl ?? contentUrl

        return (
          <a
            className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40"
            href={linkUrl}
            target={previewUrl ? undefined : "_blank"}
            rel={previewUrl ? undefined : "noopener noreferrer"}
            onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
              onClick?.(event)
              if (event.defaultPrevented || !previewUrl) return
              event.preventDefault()
              onNavigate(previewUrl)
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
  }, [onNavigate, source])

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
                <Markdown remarkPlugins={[remarkGfm]} components={components}>
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

function buildContentUrlForLinkedPath(source: MarkdownPreviewSource, filePath: string) {
  return source.kind === "project"
    ? buildProjectFileContentUrl(source.projectId, filePath)
    : buildLocalFileContentUrl(filePath)
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
  const normalized = filePath.replace(/\\/g, "/")
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
