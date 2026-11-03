import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ChunkedUploads } from "./chunked-uploads"
import { ATTACHMENT_UPLOAD_CHUNK_BYTES as CHUNK, UPLOAD_HEADERS } from "../shared/attachment-upload"

test("chunks resume after lost acknowledgements and commit a complete file exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-upload-chunks-"))
  const manager = new ChunkedUploads(path.join(root, "staging")), project = { id: "workspace", localPath: path.join(root, "project") }
  const payload = Buffer.alloc(CHUNK * 2 + 13, 0x6a), id = randomUUID()
  const send = (offset: number, owner = "owner", bytes = payload.subarray(offset, Math.min(offset + CHUNK, payload.length)), name = "中文 report.bin") => manager.upload(new Request("http://localhost/uploads", { headers: {
    [UPLOAD_HEADERS.id]: id, [UPLOAD_HEADERS.offset]: String(offset), [UPLOAD_HEADERS.total]: String(payload.length),
    [UPLOAD_HEADERS.digest]: createHash("sha256").update(bytes).digest("hex"),
  } }), new File([bytes], name, { type: "application/octet-stream" }), project, owner, 100 * CHUNK)
  try {
    await mkdir(project.localPath)
    expect((await send(0)).upload.offset).toBe(CHUNK)
    expect((await send(0)).upload.offset).toBe(CHUNK)
    await expect(send(CHUNK, "another owner")).rejects.toThrow("expired")
    await expect(send(0, "owner", Buffer.alloc(CHUNK, 0x22))).rejects.toThrow("different chunk")
    await expect(send(CHUNK, "owner", undefined, "another.bin")).rejects.toThrow("another file")
    const staged = (await readdir(path.join(root, "staging")))[0]!
    await appendFile(path.join(root, "staging", staged), Buffer.alloc(29, 0x99))
    expect((await send(CHUNK)).upload.offset).toBe(2 * CHUNK)
    const [completed, duplicate] = await Promise.all([send(2 * CHUNK), send(2 * CHUNK)])
    expect(completed.attachments).toEqual(duplicate.attachments)
    expect((await send(0)).attachments).toEqual(completed.attachments)
    const attachment = completed.attachments![0]!
    expect(attachment.size).toBe(payload.length)
    expect(await readFile(attachment.absolutePath)).toEqual(payload)
    expect((await readdir(path.dirname(attachment.absolutePath))).length).toBe(1)
    expect(await readdir(path.join(root, "staging"))).toEqual([])
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})

test("chunks reject invalid checksums and limits; expired partial uploads release staging files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-upload-expiry-"))
  let clock = Date.now()
  const manager = new ChunkedUploads(path.join(root, "staging"), () => clock)
  const file = new File([Buffer.alloc(CHUNK)], "partial.bin"), id = randomUUID(), project = { id: "workspace", localPath: root }
  const request = (offset: number, digest = createHash("sha256").update(Buffer.alloc(CHUNK)).digest("hex")) => new Request("http://localhost/uploads", { headers: {
    [UPLOAD_HEADERS.id]: id, [UPLOAD_HEADERS.offset]: String(offset), [UPLOAD_HEADERS.total]: String(2 * CHUNK), [UPLOAD_HEADERS.digest]: digest,
  } })
  try {
    await expect(manager.upload(request(0), file, project, "owner", CHUNK)).rejects.toThrow("limit")
    await expect(manager.upload(request(0, "0".repeat(64)), file, project, "owner", 2 * CHUNK)).rejects.toThrow("checksum")
    await manager.upload(request(0), file, project, "owner", 2 * CHUNK)
    expect((await readdir(path.join(root, "staging"))).length).toBe(1)
    clock += 31 * 60_000
    await expect(manager.upload(request(CHUNK), file, project, "owner", 2 * CHUNK)).rejects.toThrow("expired")
    expect(await readdir(path.join(root, "staging"))).toEqual([])
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
})
