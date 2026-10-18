import { ResourceLink } from "../ResourceLink"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react"
import {
  buildLocalFileContentUrl,
  buildLocalMarkdownPreviewUrl,
  normalizeLocalFilePath,
} from "../../../shared/local-file-urls"
import {
  buildProjectFileContentUrl,
  buildProjectMarkdownPreviewUrl,
} from "../../../shared/project-file-urls"
import { cn } from "../../lib/utils"
import { parseLocalFileLink } from "../../lib/pathUtils"
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
  contentUrl?: string
  address?: string
  workspaceId?: string
  source: MarkdownPreviewSource
  refreshVersion: number
  zoom: number
  onNavigate: (address: string) => void
  canOpenHostFiles?: boolean
  projectLocalPath?: string | null
  onOpenHostFile?: (filePath: string, action: "open_default") => void
}

export function MarkdownPreviewPanel({
  address,
  contentUrl: authorizedContentUrl,
  workspaceId,
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
  const contentUrl = authorizedContentUrl ?? buildMarkdownContentUrl(source)
  useEffect(() => {
    if (previewState.status !== "ready" || !address) return
    const hash = new URL(address, window.location.origin).hash.slice(1)
    try { if (hash) document.getElementById(decodeURIComponent(hash))?.scrollIntoView() } catch { /* malformed fragment */ }
  }, [address, previewState])

  useEffect(() => {
    let cancelled = false
    setPreviewState({ status: "loading" })
    setNavigationError(null)

    void fetchTextPreview(contentUrl, TEXT_PREVIEW_LIMIT_BYTES)
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
  }, [contentUrl, refreshVersion])

  const components = useMemo(() => {
    const baseComponents = createMarkdownComponents()
    return {
      ...baseComponents,
      a: ({ children, href, ...props }: ComponentPropsWithoutRef<"a">) => {
        if (href?.startsWith("#")) return <a {...props} href={href} onClick={event => {
          event.preventDefault()
          const current = address ?? (source.kind === "project" ? buildProjectMarkdownPreviewUrl(source.projectId, source.filePath) : buildLocalMarkdownPreviewUrl(source.filePath))
          onNavigate(current.split("#")[0] + href)
        }}>{children}</a>
        return <ResourceLink {...props} href={href} projectId={source.kind === "project" ? source.projectId : workspaceId}
          localPath={projectLocalPath} onPreview={onNavigate} className="underline text-logo"
          resolveFile={value => {
            // Absolute/file/home paths name the host; relative paths use this document's directory.
            const absolute = parseLocalFileLink(value)
            if (absolute) return absolute
            const linked = resolveMarkdownResourcePath(source, value)
            if (!linked) return null
            const host = getHostFilePath(source, linked, projectLocalPath)
            return host ? { path: host, ...getMarkdownTargetLocation(value) } : null
          }}>{children}</ResourceLink>
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
  }, [address, canOpenHostFiles, onNavigate, onOpenHostFile, projectLocalPath, source, workspaceId])

  return (
    <div className="h-full w-full overflow-auto overscroll-contain bg-background">
      <div
        className="min-h-full w-full"
        style={{ zoom }}
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
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
                  remarkPlugins={[remarkGfm, previewHeadingIds]}
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

function previewHeadingIds() {
  return (tree: any) => {
    const used = new Map<string, number>()
    const visit = (node: any) => {
      if (node.type === "heading") {
        const text = (part: any): string => part.value ?? (part.children ?? []).map(text).join("")
        const slug = text(node).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-")
        const count = used.get(slug) ?? 0; used.set(slug, count + 1)
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug + (count ? `-${count}` : "") } }
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}

function buildMarkdownContentUrl(source: MarkdownPreviewSource) {
  return source.kind === "project"
    ? buildProjectFileContentUrl(source.projectId, source.filePath)
    : buildLocalFileContentUrl(source.filePath)
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
