import { Buffer } from "node:buffer"
import type {
  DeferredToolResultContent,
  ToolResultBinaryItem,
  ToolResultContentKind,
  ToolResultEntry,
  TranscriptEntry,
} from "../shared/types"

export const DEFAULT_TOOL_RESULT_INLINE_BYTES = 32 * 1024
export const DEFAULT_TOOL_RESULT_PREVIEW_BYTES = 2 * 1024

const MAX_CONFIGURED_INLINE_BYTES = 64 * 1024 * 1024
const MAX_CONFIGURED_PREVIEW_BYTES = 64 * 1024
const MAX_BINARY_ITEMS = 8
const MAX_INSPECTION_NODES = 512
const MAX_INSPECTION_DEPTH = 12
const OMITTED_PREVIEW_VALUE = "[additional content omitted]"

export interface ToolResultProjectionOptions {
  inlineBytes: number
  previewBytes: number
}

interface InspectionState {
  nodes: number
  binaryItems: ToolResultBinaryItem[]
}

function normalizeByteLimit(
  value: number | string | undefined,
  fallback: number,
  maximum: number,
) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(parsed, maximum)
}

export function resolveToolResultProjectionOptions(
  env: Partial<Record<
    "STILLON_TOOL_RESULT_INLINE_BYTES" | "STILLON_TOOL_RESULT_PREVIEW_BYTES",
    string | undefined
  >> = process.env as Partial<Record<
    "STILLON_TOOL_RESULT_INLINE_BYTES" | "STILLON_TOOL_RESULT_PREVIEW_BYTES",
    string | undefined
  >>,
): ToolResultProjectionOptions {
  return {
    inlineBytes: normalizeByteLimit(
      env.STILLON_TOOL_RESULT_INLINE_BYTES,
      DEFAULT_TOOL_RESULT_INLINE_BYTES,
      MAX_CONFIGURED_INLINE_BYTES,
    ),
    previewBytes: normalizeByteLimit(
      env.STILLON_TOOL_RESULT_PREVIEW_BYTES,
      DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
      MAX_CONFIGURED_PREVIEW_BYTES,
    ),
  }
}

function serializedBody(entry: ToolResultEntry) {
  return JSON.stringify({
    content: entry.content,
    ...(entry.debugRaw === undefined ? {} : { debugRaw: entry.debugRaw }),
  })
}

export function getToolResultBodyByteLength(entry: ToolResultEntry) {
  return Buffer.byteLength(serializedBody(entry), "utf8")
}

function estimateBase64ByteLength(value: string) {
  const compact = value.replace(/\s+/gu, "")
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    return undefined
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function readMimeType(value: Record<string, unknown>) {
  for (const key of ["mimeType", "mime_type", "media_type"]) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key]
    }
  }
  return undefined
}

function addBinaryItem(state: InspectionState, item: ToolResultBinaryItem) {
  if (state.binaryItems.length >= MAX_BINARY_ITEMS) return
  state.binaryItems.push(item)
}

function inspectBinaryValue(
  value: unknown,
  state: InspectionState,
  depth = 0,
): void {
  if (depth > MAX_INSPECTION_DEPTH || state.nodes >= MAX_INSPECTION_NODES) {
    return
  }

  state.nodes += 1
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const dataUrl = /^data:([^;,]+)?;base64,(.+)$/su.exec(value)
      if (dataUrl) {
        addBinaryItem(state, {
          kind: dataUrl[1]?.startsWith("image/") ? "image" : "binary",
          mimeType: dataUrl[1] || undefined,
          byteLength: estimateBase64ByteLength(dataUrl[2] ?? ""),
        })
      }
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      inspectBinaryValue(item, state, depth + 1)
      if (
        state.binaryItems.length >= MAX_BINARY_ITEMS
        || state.nodes >= MAX_INSPECTION_NODES
      ) return
    }
    return
  }

  const record = value as Record<string, unknown>
  const source = (
    record.source
    && typeof record.source === "object"
    && !Array.isArray(record.source)
  )
    ? record.source as Record<string, unknown>
    : null
  const directData = typeof record.data === "string" ? record.data : undefined
  const sourceData = source && source.type === "base64" && typeof source.data === "string"
    ? source.data
    : undefined
  const base64Data = sourceData ?? directData
  const mimeType = readMimeType(record) ?? (source ? readMimeType(source) : undefined)
  const isDeclaredBinary = (
    record.type === "image"
    || record.type === "binary"
    || source?.type === "base64"
  )

  if (isDeclaredBinary && base64Data) {
    addBinaryItem(state, {
      kind: record.type === "image" || mimeType?.startsWith("image/") ? "image" : "binary",
      mimeType,
      byteLength: estimateBase64ByteLength(base64Data),
    })
    return
  }

  if (
    (record.kind === "image" || record.kind === "file")
    && typeof record.size === "number"
    && Number.isFinite(record.size)
  ) {
    addBinaryItem(state, {
      kind: record.kind === "image" || mimeType?.startsWith("image/") ? "image" : "binary",
      mimeType,
      byteLength: Math.max(0, Math.floor(record.size)),
    })
  }

  for (const nested of Object.values(record)) {
    inspectBinaryValue(nested, state, depth + 1)
    if (
      state.binaryItems.length >= MAX_BINARY_ITEMS
      || state.nodes >= MAX_INSPECTION_NODES
    ) return
  }
}

function parseStructuredString(value: string) {
  const trimmed = value.trim()
  if (
    !trimmed
    || (
      !trimmed.startsWith("{")
      && !trimmed.startsWith("[")
    )
  ) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function getPreviewSource(entry: ToolResultEntry) {
  if (typeof entry.content === "string") {
    return parseStructuredString(entry.content) ?? entry.content
  }
  if (entry.content !== null && entry.content !== undefined) {
    return entry.content
  }
  if (!entry.debugRaw) {
    return entry.content
  }
  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result ?? parsed
  } catch {
    return entry.debugRaw
  }
}

function sanitizePreviewValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown {
  if (depth > MAX_INSPECTION_DEPTH || state.nodes >= MAX_INSPECTION_NODES) {
    return OMITTED_PREVIEW_VALUE
  }

  state.nodes += 1
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const dataUrl = /^data:([^;,]+)?;base64,/u.exec(value)
      return dataUrl
        ? `[binary data${dataUrl[1] ? `: ${dataUrl[1]}` : ""} omitted]`
        : value
    }
    return value
  }

  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      if (state.nodes >= MAX_INSPECTION_NODES) {
        result.push(OMITTED_PREVIEW_VALUE)
        break
      }
      result.push(sanitizePreviewValue(item, state, depth + 1))
    }
    return result
  }

  const record = value as Record<string, unknown>
  const source = (
    record.source
    && typeof record.source === "object"
    && !Array.isArray(record.source)
  )
    ? record.source as Record<string, unknown>
    : null
  const isDeclaredBinary = (
    record.type === "image"
    || record.type === "binary"
    || source?.type === "base64"
  )
  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(record)) {
    if (state.nodes >= MAX_INSPECTION_NODES) {
      result["…"] = OMITTED_PREVIEW_VALUE
      break
    }
    if (
      isDeclaredBinary
      && (
        key === "data"
        || (key === "source" && source?.type === "base64")
      )
    ) {
      result[key] = "[binary data omitted]"
      continue
    }
    result[key] = sanitizePreviewValue(nested, state, depth + 1)
  }
  return result
}

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) {
    return ""
  }

  const marker = "…"
  const markerBytes = Buffer.byteLength(marker, "utf8")
  const contentBudget = Math.max(0, maxBytes - markerBytes)
  let consumedBytes = 0
  let previewBytes = 0
  let preview = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    consumedBytes += characterBytes
    if (consumedBytes > maxBytes) {
      return maxBytes < markerBytes ? "" : `${preview}${marker}`
    }
    if (previewBytes + characterBytes <= contentBudget) {
      preview += character
      previewBytes += characterBytes
    }
  }
  return value
}

function describeBinaryItems(items: ToolResultBinaryItem[]) {
  if (items.length === 0) return ""
  return items.map((item) => {
    const label = item.mimeType ?? item.kind
    return item.byteLength === undefined
      ? `[${label}]`
      : `[${label}, ${item.byteLength} bytes]`
  }).join("\n")
}

function createPreview(
  entry: ToolResultEntry,
  kind: ToolResultContentKind,
  binaryItems: ToolResultBinaryItem[],
  previewBytes: number,
) {
  const source = getPreviewSource(entry)
  const sanitized = sanitizePreviewValue(source, { nodes: 0 })
  let value = typeof sanitized === "string"
    ? sanitized
    : JSON.stringify(sanitized, null, 2)
  if (kind === "binary") {
    const binaryDescription = describeBinaryItems(binaryItems)
    value = [binaryDescription, value].filter(Boolean).join("\n")
  }
  return truncateUtf8(value ?? "", previewBytes)
}

function inspectContent(entry: ToolResultEntry) {
  const source = getPreviewSource(entry)
  const state: InspectionState = {
    nodes: 0,
    binaryItems: [],
  }
  inspectBinaryValue(source, state)
  const contentKind: ToolResultContentKind = state.binaryItems.length > 0
    ? "binary"
    : typeof source === "string"
      ? "text"
      : "json"
  return {
    contentKind,
    binaryItems: state.binaryItems,
  }
}

export function projectToolResultEntry(
  entry: ToolResultEntry,
  revision: string,
  options: ToolResultProjectionOptions = resolveToolResultProjectionOptions(),
): ToolResultEntry {
  if (entry.deferredContent) {
    return entry
  }

  const byteLength = getToolResultBodyByteLength(entry)
  if (byteLength <= options.inlineBytes) {
    return entry
  }

  const { contentKind, binaryItems } = inspectContent(entry)
  const preview = createPreview(
    entry,
    contentKind,
    binaryItems,
    options.previewBytes,
  )
  const deferredContent: DeferredToolResultContent = {
    version: 1,
    resultId: entry._id,
    revision,
    byteLength,
    contentKind,
    preview,
    previewByteLength: Buffer.byteLength(preview, "utf8"),
    truncated: true,
    ...(binaryItems.length > 0 ? { binaryItems } : {}),
  }
  const {
    content: _content,
    debugRaw: _debugRaw,
    deferredContent: _deferredContent,
    ...metadata
  } = entry
  return {
    ...metadata,
    content: null,
    deferredContent,
  }
}

export function projectToolResultEntries(
  entries: TranscriptEntry[],
  revision: string,
  options: ToolResultProjectionOptions = resolveToolResultProjectionOptions(),
): TranscriptEntry[] {
  const interactiveToolIds = new Set(
    entries.flatMap((entry) => (
      entry.kind === "tool_call"
      && (
        entry.tool.toolKind === "ask_user_question"
        || entry.tool.toolKind === "exit_plan_mode"
      )
        ? [entry.tool.toolId]
        : []
    )),
  )
  let projected: TranscriptEntry[] | null = null
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const next = entry.kind === "tool_result" && !interactiveToolIds.has(entry.toolId)
      ? projectToolResultEntry(entry, revision, options)
      : entry
    if (next !== entry && !projected) {
      projected = entries.slice(0, index)
    }
    projected?.push(next)
  }
  return projected ?? entries
}
