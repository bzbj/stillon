import type { ChatAttachment } from "../../shared/types"
import { ATTACHMENT_UPLOAD_CHUNK_BYTES, ATTACHMENT_UPLOAD_MAX_BYTES, ATTACHMENT_UPLOAD_PROTOCOL, UPLOAD_HEADERS } from "../../shared/attachment-upload"
import { generateUUID } from "./utils"

export interface AttachmentUploadArgs {
  projectId: string; file: File; uploadId?: string; signal?: AbortSignal
  onProgress?: (progress: number) => void; onRetry?: (attempt: number) => void
}
type ResponseError = (value: { status: number; contentType: string; responseText: string; challenged?: boolean; requestId?: string | null }) => string
interface ChunkReply { upload: { id: string; offset: number; size: number }; attachments?: ChatAttachment[] }
class UploadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message) }
}
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const cancel = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve() }, ms)
    signal?.addEventListener("abort", cancel, { once: true })
  })
}
function sendChunk(args: AttachmentUploadArgs, id: string, offset: number, chunk: File, digest: string, responseError: ResponseError) {
  return new Promise<ChunkReply>((resolve, reject) => {
    args.signal?.throwIfAborted()
    const request = new XMLHttpRequest(), body = new FormData()
    body.append("files", chunk)
    request.open("POST", `/api/projects/${args.projectId}/uploads`)
    for (const [name, value] of Object.entries({ [UPLOAD_HEADERS.protocol]: String(ATTACHMENT_UPLOAD_PROTOCOL), [UPLOAD_HEADERS.id]: id,
      [UPLOAD_HEADERS.offset]: String(offset), [UPLOAD_HEADERS.total]: String(args.file.size), [UPLOAD_HEADERS.digest]: digest })) request.setRequestHeader(name, value)
    let idle: ReturnType<typeof setTimeout>
    const activity = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; request.abort() }, 60_000) }
    let timedOut = false
    const abort = () => request.abort()
    const cleanup = () => { clearTimeout(idle); args.signal?.removeEventListener("abort", abort) }
    args.signal?.addEventListener("abort", abort, { once: true })
    request.upload.addEventListener("progress", event => {
      activity()
      if (event.lengthComputable && event.total > 0) args.onProgress?.(Math.round((offset + chunk.size * Math.min(1, event.loaded / event.total)) / args.file.size * 100))
    })
    request.upload.addEventListener("load", activity)
    request.addEventListener("progress", activity)
    request.addEventListener("load", () => {
      cleanup()
      const contentType = request.getResponseHeader("content-type") ?? ""
      let value: ChunkReply | undefined
      try { value = JSON.parse(request.responseText) as ChunkReply } catch { /* Transport error page. */ }
      if (request.status >= 200 && request.status < 300 && value?.upload?.id === id
        && value.upload.size === args.file.size && Number.isSafeInteger(value.upload.offset)
        && value.upload.offset >= offset + chunk.size && value.upload.offset <= args.file.size
        && (value.upload.offset === args.file.size || value.upload.offset % ATTACHMENT_UPLOAD_CHUNK_BYTES === 0)) { resolve(value); return }
      const retryable = request.status === 0 || [408, 429, 502, 503, 504].includes(request.status) || request.status === 404 && contentType.includes("text/html")
      reject(new UploadFailure(responseError({ status: request.status, contentType, responseText: request.responseText,
        challenged: request.getResponseHeader("cf-mitigated") === "challenge", requestId: request.getResponseHeader("x-request-id") }), retryable))
    })
    request.addEventListener("error", () => { cleanup(); reject(new UploadFailure("The upload connection was interrupted.", true)) })
    request.addEventListener("abort", () => { cleanup(); reject(timedOut ? new UploadFailure("The upload stopped making progress.", true) : new DOMException("The upload was aborted.", "AbortError")) })
    try { activity(); request.send(body) } catch (error) { cleanup(); reject(error) }
  })
}

export async function uploadAttachmentWithRecovery(args: AttachmentUploadArgs, legacy: (args: AttachmentUploadArgs) => Promise<ChatAttachment>, responseError: ResponseError) {
  if (args.file.size > ATTACHMENT_UPLOAD_MAX_BYTES) throw new Error("This file exceeds the 100 MB attachment limit.")
  // Protocol 1 requires a positive byte count; empty files retain legacy handling.
  if (args.file.size === 0) return legacy(args)
  let capabilities!: Response, text = ""
  for (let attempt = 0; ; attempt++) {
    try {
      capabilities = await fetch(`/api/projects/${args.projectId}/uploads`, { cache: "no-store",
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(args.signal ? [args.signal] : [])]) })
      text = await capabilities.text()
      const type = capabilities.headers.get("content-type") ?? ""
      if (attempt < 3 && ([408, 429, 502, 503, 504].includes(capabilities.status) || capabilities.status === 404 && type.includes("text/html"))) {
        args.onRetry?.(attempt + 1); await wait([1000, 3000, 8000][attempt]!, args.signal); continue
      }
      break
    } catch (error) {
      if (args.signal?.aborted || attempt === 3) throw error
      args.onRetry?.(attempt + 1); await wait([1000, 3000, 8000][attempt]!, args.signal)
    }
  }
  if (capabilities.status === 405 || capabilities.ok && !capabilities.headers.get("content-type")?.includes("application/json")) return legacy(args)
  if (!capabilities.ok) throw new Error(responseError({ status: capabilities.status, contentType: capabilities.headers.get("content-type") ?? "", responseText: text }))
  const support = JSON.parse(text)
  if (support.protocol !== ATTACHMENT_UPLOAD_PROTOCOL || support.chunkBytes !== ATTACHMENT_UPLOAD_CHUNK_BYTES) return legacy(args)
  if (!Number.isSafeInteger(support.maxFileBytes) || support.maxFileBytes <= 0) throw new Error("The server returned invalid upload limits.")
  if (args.file.size > support.maxFileBytes) throw new Error(`This file exceeds the ${Math.floor(support.maxFileBytes / 1024 / 1024)} MB attachment limit.`)
  const id = args.uploadId ?? generateUUID()
  let offset = 0
  while (offset < args.file.size) {
    args.signal?.throwIfAborted()
    const chunk = new File([args.file.slice(offset, offset + support.chunkBytes)], args.file.name, { type: args.file.type || "application/octet-stream" })
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await chunk.arrayBuffer()))
    const digest = [...hash].map(value => value.toString(16).padStart(2, "0")).join("")
    let value: Awaited<ReturnType<typeof sendChunk>> | undefined
    for (let attempt = 0; ; attempt++) {
      try { value = await sendChunk(args, id, offset, chunk, digest, responseError); break }
      catch (error) {
        if (!(error instanceof UploadFailure) || !error.retryable) throw error
        if (attempt === 3) throw new Error("The upload connection was interrupted. Retry the attachment to continue from its confirmed progress.")
        args.onRetry?.(attempt + 1)
        await wait([1000, 3000, 8000][attempt]!, args.signal)
      }
    }
    offset = value.upload.offset
    args.onProgress?.(Math.round(offset / args.file.size * 100))
    if (offset === args.file.size) {
      const attachment = value.attachments?.[0]
      if (!attachment || attachment.size !== args.file.size) throw new Error("The server did not confirm the complete attachment. Retry this attachment.")
      return attachment
    }
  }
  throw new Error("The upload did not complete.")
}
