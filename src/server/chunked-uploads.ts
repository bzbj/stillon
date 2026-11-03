import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { ChatAttachment } from "../shared/types"
import { ATTACHMENT_UPLOAD_CHUNK_BYTES, UPLOAD_HEADERS } from "../shared/attachment-upload"
import { persistProjectUpload } from "./uploads"

const IDLE_MS = 30 * 60_000
interface Upload {
  file: string; name: string; mime: string; size: number; offset: number; touched: number
  hashes: Map<number, string>; attachment?: ChatAttachment
}
export class ChunkUploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** Staging stays on the computer; the cloud gateway only forwards these requests. */
export class ChunkedUploads {
  private readonly uploads = new Map<string, Upload>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private lastSweep = 0
  constructor(private readonly directory: string, private readonly now = Date.now) {}

  async upload(request: Request, file: File, project: { id: string; localPath: string }, owner: string, limit: number) {
    const id = request.headers.get(UPLOAD_HEADERS.id) ?? ""
    const offsetText = request.headers.get(UPLOAD_HEADERS.offset) ?? "", totalText = request.headers.get(UPLOAD_HEADERS.total) ?? ""
    const digest = request.headers.get(UPLOAD_HEADERS.digest) ?? ""
    if (!/^[\w-]{16,64}$/u.test(id) || !/^\d+$/u.test(offsetText) || !/^\d+$/u.test(totalText) || !/^[a-f0-9]{64}$/u.test(digest)) throw new ChunkUploadError("Invalid upload chunk metadata.")
    const offset = Number(offsetText), size = Number(totalText)
    if (!Number.isSafeInteger(size) || size <= 0 || size > limit) throw new ChunkUploadError(`File exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`, 413)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size || offset % ATTACHMENT_UPLOAD_CHUNK_BYTES !== 0
      || file.size !== Math.min(ATTACHMENT_UPLOAD_CHUNK_BYTES, size - offset)) throw new ChunkUploadError("Invalid upload chunk size or offset.")
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new ChunkUploadError("Upload chunk checksum does not match.")
    const key = JSON.stringify([project.id, owner, id])
    const operation = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.expire(key)
      let upload = this.uploads.get(key)
      if (!upload) {
        if (offset !== 0) throw new ChunkUploadError("Upload expired. Retry this attachment to start again.", 409)
        if ([...this.uploads.values()].filter(value => !value.attachment).length >= 16) throw new ChunkUploadError("Too many unfinished uploads. Retry later.", 429)
        if (this.uploads.size >= 256) {
          const old = [...this.uploads].find(([other, value]) => value.attachment && !this.locks.has(other))
          if (old) this.uploads.delete(old[0])
          else throw new ChunkUploadError("Upload recovery is busy. Retry later.", 429)
        }
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        upload = { file: path.join(this.directory, randomUUID() + ".part"), name: file.name, mime: file.type,
          size, offset: 0, touched: this.now(), hashes: new Map() }
        this.uploads.set(key, upload)
      }
      if (upload.size !== size || upload.name !== file.name || upload.mime !== file.type) throw new ChunkUploadError("This upload ID belongs to another file.", 409)
      upload.touched = this.now()
      if (offset < upload.offset) {
        if (upload.hashes.get(offset) !== digest) throw new ChunkUploadError("A different chunk was already accepted at this offset.", 409)
      } else {
        if (offset !== upload.offset) throw new ChunkUploadError("Upload chunks must arrive in order.", 409)
        // Windows append-only handles cannot truncate. Use explicit positions so
        // retries can discard an unacknowledged partial write on every platform.
        const handle = await open(upload.file, upload.offset === 0 ? "w+" : "r+", 0o600)
        try {
          await handle.truncate(upload.offset)
          let written = 0
          while (written < bytes.byteLength) {
            const result = await handle.write(bytes, written, bytes.byteLength - written, upload.offset + written)
            if (result.bytesWritten === 0) throw new Error("Upload chunk write made no progress")
            written += result.bytesWritten
          }
        }
        finally { await handle.close() }
        upload.hashes.set(offset, digest)
        upload.offset += bytes.byteLength
      }
      if (upload.offset === upload.size && !upload.attachment) {
        const complete = new Uint8Array(await Bun.file(upload.file).arrayBuffer())
        if (complete.byteLength !== upload.size) throw new ChunkUploadError("Upload length does not match. Retry this attachment.", 409)
        upload.attachment = await persistProjectUpload({ projectId: project.id, localPath: project.localPath,
          fileName: upload.name, fallbackMimeType: upload.mime, bytes: complete })
        // The receipt survives a lost final response for this process/session.
        await rm(upload.file, { force: true }).catch(() => {})
      }
      return { upload: { id, offset: upload.offset, size: upload.size }, ...(upload.attachment ? { attachments: [upload.attachment] } : {}) }
    })
    this.locks.set(key, operation)
    try { return await operation }
    finally { if (this.locks.get(key) === operation) this.locks.delete(key) }
  }

  private async expire(current: string) {
    for (const [key, upload] of this.uploads) if (this.now() - upload.touched > IDLE_MS && (key === current || !this.locks.has(key))) {
      this.uploads.delete(key)
      await rm(upload.file, { force: true })
    }
    if (this.now() - this.lastSweep > 60_000) {
      this.lastSweep = this.now()
      const live = new Set([...this.uploads.values()].map(upload => upload.file))
      for (const file of await readdir(this.directory, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !/^[a-f0-9-]{36}\.part$/u.test(file.name)) continue
        const candidate = path.join(this.directory, file.name)
        if (!live.has(candidate) && this.now() - (await stat(candidate)).mtimeMs > IDLE_MS) await rm(candidate, { force: true })
      }
    }
  }
  async close() {
    await Promise.allSettled([...this.locks.values()])
    await Promise.all([...this.uploads.values()].map(upload => rm(upload.file, { force: true })))
    this.uploads.clear()
  }
}
