import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { uploadAttachmentWithRecovery } from "./attachmentUpload"
import { startStillOnServer } from "../../server/server"
import { UPLOAD_HEADERS, ATTACHMENT_UPLOAD_CHUNK_BYTES as CHUNK } from "../../shared/attachment-upload"
import type { ChatAttachment } from "../../shared/types"

test("uploads recover lost chunk and final replies, resume an explicit retry and never duplicate the saved file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-upload-client-"))
  const server = await startStillOnServer({ dataDir: path.join(root, "state"), discoveryHome: root, port: 0, strictPort: true,
    connect: { origin: "http://127.0.0.1:9", frpcPath: process.execPath, environment: {} },
    codexModelDiscovery: { discover: async () => { throw new Error("Disabled in fixture") } } })
  const origin = `http://127.0.0.1:${server.port}`, networkFetch = globalThis.fetch, originalXhr = globalThis.XMLHttpRequest
  const offsets: number[] = [], dropped = new Set<number>()
  let mode: "lost-replies" | "manual-retry" | "normal" | "auth" = "lost-replies"
  let failedOnce = false
  class FixtureXHR extends EventTarget {
    upload = new EventTarget(); status = 0; responseText = ""; headers = new Headers(); responseHeaders = new Headers()
    url = ""; controller = new AbortController()
    open(_method: string, url: string) { this.url = url }
    setRequestHeader(name: string, value: string) { this.headers.set(name, value) }
    getResponseHeader(name: string) { return this.responseHeaders.get(name) }
    abort() { this.controller.abort(); this.dispatchEvent(new Event("abort")); this.dispatchEvent(new Event("loadend")) }
    send(body: FormData) {
      const offset = Number(this.headers.get(UPLOAD_HEADERS.offset)); offsets.push(offset)
      void (async () => {
        this.upload.dispatchEvent(Object.assign(new Event("progress"), { lengthComputable: true, loaded: CHUNK, total: CHUNK }))
        this.upload.dispatchEvent(new Event("load"))
        let response: Response
        if (mode === "auth") response = Response.json({ error: "AUTH_REQUIRED" }, { status: 401 })
        else if (mode === "manual-retry" && offset === 2 * CHUNK && !failedOnce) {
          failedOnce = true; response = Response.json({ error: "Fixture failure" }, { status: 500 })
        } else response = await networkFetch(origin + this.url, { method: "POST", headers: { origin, ...Object.fromEntries(this.headers) }, body, signal: this.controller.signal })
        this.status = response.status; this.responseHeaders = new Headers(response.headers); this.responseText = await response.text()
        const singleChunk = Number(this.headers.get(UPLOAD_HEADERS.total)) <= CHUNK
        if (mode === "lost-replies" && (singleChunk || [CHUNK, 4 * CHUNK].includes(offset)) && !dropped.has(offset)) {
          dropped.add(offset)
          if (offset === CHUNK) this.dispatchEvent(new Event("error"))
          else {
            this.status = 404; this.responseHeaders = new Headers({ "content-type": "text/html" })
            this.responseText = "<html>The server is powered by frp.</html>"
            this.dispatchEvent(new Event("load"))
          }
        } else this.dispatchEvent(new Event("load"))
        this.dispatchEvent(new Event("loadend"))
      })().catch(() => { this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("loadend")) })
    }
  }
  globalThis.XMLHttpRequest = FixtureXHR as unknown as typeof XMLHttpRequest
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => networkFetch(typeof input === "string" && input.startsWith("/") ? origin + input : input,
    { ...init, headers: { origin, ...Object.fromEntries(new Headers(init?.headers)) } })) as typeof fetch
  try {
    const project = await server.store.openProject(path.join(root, "workspace"), "Upload workspace")
    const payload = Buffer.alloc(4 * CHUNK + 19)
    for (let n = 0; n < payload.length; n++) payload[n] = (n >>> 17) % 251
    const file = new File([payload], "complete.bin", { type: "application/octet-stream" })
    const legacy = async (): Promise<ChatAttachment> => { throw new Error("Legacy upload must not run") }
    const describe = ({ status }: { status: number }) => "HTTP " + status
    const progress: number[] = []
    const result = await uploadAttachmentWithRecovery({ projectId: project.id, file, uploadId: randomUUID(), onProgress: value => progress.push(value) }, legacy, describe)
    expect(await readFile(result.absolutePath)).toEqual(payload)
    expect(offsets).toEqual([0, CHUNK, CHUNK, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK, 4 * CHUNK])
    expect(Math.max(...progress)).toBe(100)
    expect((await readdir(path.dirname(result.absolutePath))).length).toBe(1)
    mode = "manual-retry"; offsets.length = 0
    const id = randomUUID()
    await expect(uploadAttachmentWithRecovery({ projectId: project.id, file, uploadId: id }, legacy, describe)).rejects.toThrow("HTTP 500")
    mode = "normal"
    const resumed = await uploadAttachmentWithRecovery({ projectId: project.id, file, uploadId: id }, legacy, describe)
    expect(offsets).toEqual([0, CHUNK, 2 * CHUNK, 0, 2 * CHUNK, 3 * CHUNK, 4 * CHUNK])
    expect(await readFile(resumed.absolutePath)).toEqual(payload)
    expect((await readdir(path.dirname(result.absolutePath))).length).toBe(2)
    // Screenshots and tiny files used to bypass receipts and transient retries.
    // Lose a final reply after saving; replay must return that same attachment.
    let savedFiles = 2
    for (const size of [1, 373 * 1024, CHUNK, CHUNK + 1]) {
      mode = "lost-replies"; offsets.length = 0; dropped.clear()
      const bytes = Buffer.alloc(size, 0x71), retries: number[] = []
      const small = await uploadAttachmentWithRecovery({ projectId: project.id,
        file: new File([bytes], "screenshot.bin"), uploadId: randomUUID(), onRetry: attempt => retries.push(attempt) }, legacy, describe)
      expect(await readFile(small.absolutePath)).toEqual(bytes)
      expect(offsets).toEqual(size <= CHUNK ? [0, 0] : [0, CHUNK, CHUNK])
      expect(retries).toEqual([1])
      expect((await readdir(path.dirname(result.absolutePath))).length).toBe(++savedFiles)
    }
    mode = "auth"; offsets.length = 0
    await expect(uploadAttachmentWithRecovery({ projectId: project.id, file: new File(["small"], "small.txt") }, legacy, describe)).rejects.toThrow("HTTP 401")
    expect(offsets.length).toBe(1)
  } finally {
    globalThis.fetch = networkFetch; globalThis.XMLHttpRequest = originalXhr
    await server.stop(); await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test("older hosts receive the complete legacy upload; oversized files are refused before network I/O", async () => {
  const original = globalThis.fetch
  let reads = 0, calls = 0
  globalThis.fetch = (async () => { reads++; return new Response("<html>old host</html>", { headers: { "content-type": "text/html" } }) }) as typeof fetch
  try {
    const file = new File([new Uint8Array(373 * 1024)], "legacy.bin")
    const legacy = async (args: { file: File }) => { calls++; expect(args.file).toBe(file); return { id: "fixture" } as ChatAttachment }
    expect((await uploadAttachmentWithRecovery({ projectId: "workspace", file }, legacy, () => "error")).id).toBe("fixture")
    expect(calls).toBe(1); expect(reads).toBe(1)
    Object.defineProperty(file, "size", { value: 101 * CHUNK })
    await expect(uploadAttachmentWithRecovery({ projectId: "workspace", file }, legacy, () => "error")).rejects.toThrow("100 MB")
    expect(reads).toBe(1); expect(calls).toBe(1)
  } finally { globalThis.fetch = original }
})

test("empty attachments preserve legacy handling without negotiating a positive-size protocol", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { throw new Error("Empty files must not negotiate chunk support") }) as typeof fetch
  try {
    const file = new File([], "empty.txt")
    const attachment = { id: "empty", size: 0 } as ChatAttachment
    const result = await uploadAttachmentWithRecovery({ projectId: "workspace", file }, async args => {
      calls++; expect(args.file).toBe(file); return attachment
    }, () => "error")
    expect(result).toBe(attachment)
    expect(calls).toBe(1)
  } finally { globalThis.fetch = original }
})
