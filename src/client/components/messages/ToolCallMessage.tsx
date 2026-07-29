import { UserRound, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { MetaRow, MetaLabel, MetaCodeBlock, ExpandableRow, VerticalLineContainer, getToolIcon } from "./shared"
import { useEffect, useMemo, useState } from "react"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { formatBashCommandTitle, toTitleCase } from "../../lib/formatters"
import { FileContentView } from "./FileContentView"
import { hasToolResult, hydrateToolResult } from "../../../shared/tools"
import type { DeferredToolResultContent } from "../../../shared/types"
import { useToolResultHydration } from "./tool-result-hydration"
import type { ToolResultLoadState } from "../../lib/toolResultSessionStore"

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
}

type ReadImageBlock = {
  type: "image"
  data: string
  mimeType?: string
}

function extractReadImageBlocks(value: unknown): ReadImageBlock[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []

  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") {
      return []
    }

    if ("data" in block && typeof block.data === "string") {
      return [{
        type: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      } satisfies ReadImageBlock]
    }

    if (
      "source" in block
      && block.source
      && typeof block.source === "object"
      && "type" in block.source
      && block.source.type === "base64"
      && "data" in block.source
      && typeof block.source.data === "string"
    ) {
      return [{
        type: "image",
        data: block.source.data,
        mimeType: typeof block.source.media_type === "string" ? block.source.media_type : undefined,
      } satisfies ReadImageBlock]
    }

    return []
  })
}

export function ReadResultImages({ images }: { images: ReadonlyArray<ReadImageBlock> }) {
  return (
    <div className="flex flex-col gap-3">
      {images.map((image, index) => {
        const mimeType = image.mimeType || "image/png"
        return (
          <div key={`${mimeType}:${index}`} className="overflow-hidden rounded-lg border border-border bg-muted/20">
            <img
              src={`data:${mimeType};base64,${image.data}`}
              alt={`Read result ${index + 1}`}
              className="max-h-[50vh] w-full object-contain bg-background"
            />
          </div>
        )
      })}
    </div>
  )
}

function formatByteLength(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function DeferredResultPanel({
  descriptor,
  state,
  onRetry,
  onRefresh,
}: {
  descriptor: DeferredToolResultContent
  state: ToolResultLoadState | { status: "unavailable" } | null
  onRetry: () => void
  onRefresh: () => void
}) {
  const status = state?.status ?? "unavailable"
  return (
    <div
      className="flex flex-col gap-2"
      aria-busy={status === "loading"}
    >
      <MetaCodeBlock label="Result preview" copyable={false}>
        {descriptor.preview || "No textual preview is available."}
      </MetaCodeBlock>
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <span role="status" aria-live="polite">
          {status === "preview" ? "Loading the full result on demand…" : null}
          {status === "loading" ? "Loading full result…" : null}
          {state?.status === "error"
            ? `Could not load the full result: ${state.message}`
            : null}
          {status === "missing"
            ? "The full result is no longer available in this transcript."
            : null}
          {status === "stale"
            ? "The transcript changed before this result was loaded."
            : null}
          {status === "unavailable"
            ? "The full result was not included in this readonly transcript."
            : null}
        </span>
        {status === "error" ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
        {status === "stale" ? (
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
            onClick={onRefresh}
          >
            Refresh transcript
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function ToolCallMessage({ message, isLoading = false, localPath }: Props) {
  const [expanded, setExpanded] = useState(false)
  const deferred = message.deferredResult
  const hydration = useToolResultHydration(deferred)
  const hydratedEntry = hydration.state?.status === "ready"
    ? hydration.state.entry
    : null
  const hydratedResult = useMemo(() => (
    hydratedEntry
      ? hydrateToolResult(message, hydratedEntry.content)
      : message.result
  ), [hydratedEntry, message])
  const hydratedRawResult = hydratedEntry?.content ?? message.rawResult
  const hasResult = hasToolResult(message)
  const hasFullResult = hydratedEntry !== null || message.result !== undefined
  const showLoadingState = !hasResult && isLoading
  const previewLine = deferred?.preview
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim()

  const name = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
    if (message.toolKind === "glob") {
      return `Search files ${message.input.pattern === "**/*" ? "in all directories" : `matching ${message.input.pattern}`}`
    }
    if (message.toolKind === "grep") {
      const pattern = message.input.pattern
      const outputMode = message.input.outputMode
      if (outputMode === "count") {
        return `Count \`${pattern}\` occurrences`
      }
      if (outputMode === "content") {
        return `Find \`${pattern}\` in text`
      }
      return `Find \`${pattern}\` in files`
    }
    if (message.toolKind === "bash") {
      return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
    }
    if (message.toolKind === "web_search") {
      return message.input.query || "Web Search"
    }
    if (message.toolKind === "read_file") {
      return `Read ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "write_file") {
      return `Write ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "edit_file") {
      return `Edit ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "delete_file") {
      return `Delete ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "mcp_generic") {
      return `${toTitleCase(message.input.tool)} from ${toTitleCase(message.input.server)}`
    }
    if (message.toolKind === "subagent_task") {
      return message.input.subagentType || message.toolName
    }
    return message.toolName
  }, [message.input, message.toolName, localPath])

  const isAgent = useMemo(() => message.toolKind === "subagent_task", [message.toolKind])
  const description = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
  }, [message.input, message.toolKind])

  const isBashTool = message.toolKind === "bash"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isDeleteTool = message.toolKind === "delete_file"
  const isReadTool = message.toolKind === "read_file"
  const hidesSuccessfulResult = (
    (isWriteTool || isEditTool || isDeleteTool)
    && !message.isError
  )
  const shouldHydrateDeferredResult = Boolean(deferred && !hidesSuccessfulResult)

  useEffect(() => {
    if (!expanded || !shouldHydrateDeferredResult || !hydration.request) {
      return
    }
    const release = hydration.retain()
    void hydration.load()
    return release
  }, [
    expanded,
    hydration.load,
    hydration.request,
    hydration.retain,
    shouldHydrateDeferredResult,
  ])

  const resultText = useMemo(() => {
    if (typeof hydratedResult === "string") return hydratedResult
    if (hydratedResult === undefined) return ""
    if (typeof hydratedResult === "object" && hydratedResult !== null && "content" in hydratedResult) {
      const content = (hydratedResult as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(hydratedResult, null, 2) ?? String(hydratedResult)
  }, [hydratedResult])

  const readImages = useMemo(() => {
    if (!isReadTool) {
      return [] as ReadImageBlock[]
    }

    if (hydratedResult && typeof hydratedResult === "object" && "blocks" in hydratedResult) {
      const blocks = (hydratedResult as { blocks?: unknown }).blocks
      if (Array.isArray(blocks)) {
        const hydratedBlocks = extractReadImageBlocks(blocks)
        if (hydratedBlocks.length > 0) {
          return hydratedBlocks
        }
      }
    }

    return extractReadImageBlocks(hydratedRawResult)
  }, [hydratedRawResult, hydratedResult, isReadTool])

  const inputText = useMemo(() => {
    switch (message.toolKind) {
      case "bash":
        return message.input.command
      case "write_file":
      case "delete_file":
        return message.input.content
      default:
        return JSON.stringify(message.input, null, 2)
    }
  }, [message])

  return (
    <MetaRow className="w-full">
      <ExpandableRow
        onExpandedChange={setExpanded}
        expandedContent={
          <VerticalLineContainer className="my-4 text-sm">
            <div className="flex flex-col gap-2">
              {isEditTool ? (
                <FileContentView
                  content=""
                  isDiff
                  oldString={message.input.oldString}
                  newString={message.input.newString}
                />
              ) : isDeleteTool ? (
                <FileContentView
                  content={message.input.content}
                />
              ) : !isReadTool && !isWriteTool && (
                <MetaCodeBlock label={
                  isBashTool ? (
                    <span className="flex items-center gap-2 w-full">
                      <span>Command</span>
                      {!!message.input.timeoutMs && (
                        <span className="text-muted-foreground">timeout: {String(message.input.timeoutMs)}ms</span>
                      )}
                      {!!message.input.runInBackground && (
                        <span className="text-muted-foreground">background</span>
                      )}
                    </span>
                  ) : isWriteTool ? "Contents" : "Input"
                } copyText={inputText}>
                  {inputText}
                </MetaCodeBlock>
              )}
              {deferred && shouldHydrateDeferredResult && !hasFullResult ? (
                <DeferredResultPanel
                  descriptor={deferred}
                  state={hydration.state}
                  onRetry={() => {
                    void hydration.load({ force: true })
                  }}
                  onRefresh={hydration.refreshTranscript}
                />
              ) : null}
              {hasFullResult && isReadTool && !message.isError && (
                readImages.length > 0 ? (
                  <div>
                    <span className="font-medium text-muted-foreground">Image</span>
                    <div className="mt-1">
                      <ReadResultImages images={readImages} />
                    </div>
                  </div>
                ) : (
                  <FileContentView
                    content={resultText}
                  />
                )
              )}
              {isWriteTool && !message.isError && (
                <FileContentView
                  content={message.input.content}
                />
              )}
              {hasFullResult && !isReadTool && !hidesSuccessfulResult && (
                <MetaCodeBlock label={message.isError ? "Error" : "Result"} copyText={resultText}>
                  {resultText}
                </MetaCodeBlock>
              )}
            </div>
          </VerticalLineContainer>
        }
      >

        <div className={`w-5 h-5 relative flex items-center justify-center`}>
          {(() => {
            if (message.isError) {
              return <X className="size-4 text-destructive" />
            }
            if (isAgent) {
              return <UserRound className="size-4 text-muted-icon" />
            }
            const Icon = getToolIcon(message.toolName)

            return <Icon className="size-4 text-muted-icon" />
          })()}
        </div>
        <MetaLabel className="min-w-0 text-left transition-opacity duration-200">
          <span className="block truncate">
            <AnimatedShinyText
              animate={showLoadingState}
              shimmerWidth={Math.max(20, ((description || name)?.length ?? 33) * 3)}
            >
              {description || name}
            </AnimatedShinyText>
            {deferred ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {deferred.contentKind} · {formatByteLength(deferred.byteLength)}
              </span>
            ) : null}
          </span>
          {previewLine ? (
            <span
              className="mt-0.5 block truncate text-xs font-normal text-muted-foreground"
              title={deferred?.preview}
            >
              {previewLine}
            </span>
          ) : null}
        </MetaLabel>



      </ExpandableRow>
    </MetaRow>
  )
}
