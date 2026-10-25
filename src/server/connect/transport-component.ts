import { createHash } from "node:crypto"
import { gunzipSync, inflateRawSync } from "node:zlib"

export const FRP_VERSION = "0.71.1"
export const TRANSPORT_DESCRIPTOR = "runtime/frp-component.json"
export const MAX_TRANSPORT_BYTES = 64 * 1024 * 1024
export const transportHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export interface TransportComponent {
  schema: 1
  version: string
  platform: "win32" | "darwin" | "linux"
  architecture: "x64" | "arm64"
  archive: { url: string; sha256: string; format: "zip" | "tar.gz"; prefix: string }
  executable: { sha256: string; size: number }
  signing: "unsigned" | "authenticode" | "developer-id"
}
export type TransportErrorCode = "CONNECTOR_NOT_INSTALLED" | "CONNECTOR_INTEGRITY_FAILED" | "CONNECTOR_DOWNLOAD_FAILED"
  | "CONNECTOR_BLOCKED" | "CONNECTOR_REPAIR_REQUIRED" | "CONNECTOR_PREPARING" | "CONNECTOR_COMPONENT_INVALID"
export class TransportError extends Error {
  constructor(public code: TransportErrorCode) { super(code) }
}
export function validateTransportComponent(value: unknown, target: { platform: string; architecture: string } = { platform: process.platform, architecture: process.arch }): TransportComponent {
  const c = value as TransportComponent
  try {
    const url = new URL(c.archive.url)
    if (c.schema !== 1 || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(c.version)
      || c.platform !== target.platform || c.architecture !== target.architecture
      || !["win32", "darwin", "linux"].includes(c.platform) || !["x64", "arm64"].includes(c.architecture)
      || !["zip", "tar.gz"].includes(c.archive.format) || !/^[a-f0-9]{64}$/.test(c.archive.sha256)
      || !/^[a-f0-9]{64}$/.test(c.executable.sha256) || !Number.isSafeInteger(c.executable.size)
      || c.executable.size < 1 || c.executable.size > MAX_TRANSPORT_BYTES
      || !/^(?:[a-zA-Z0-9._-]+\/)*$/.test(c.archive.prefix) || c.archive.prefix.split("/").includes("..")
      || url.protocol !== "https:" || url.username || url.password || url.hash
      || !["unsigned", "authenticode", "developer-id"].includes(c.signing)
      || (c.signing === "authenticode" && c.platform !== "win32") || (c.signing === "developer-id" && c.platform !== "darwin")) throw new Error()
    return c
  } catch { throw new TransportError("CONNECTOR_COMPONENT_INVALID") }
}
export const transportBinary = (component: TransportComponent) => component.platform === "win32" ? "frpc.exe" : "frpc"

/** ZIP entries stay in memory: never extract links or archive-controlled paths. */
function zipFiles(bytes: Uint8Array, wanted: string[]) {
  const buffer = Buffer.from(bytes)
  let end = buffer.length - 22
  while (end >= Math.max(0, buffer.length - 65_557) && buffer.readUInt32LE(end) !== 0x06054b50) end--
  if (end < Math.max(0, buffer.length - 65_557) || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error("Invalid ZIP")
  const count = buffer.readUInt16LE(end + 10), central = buffer.readUInt32LE(end + 16)
  if (count > 256 || central >= end) throw new Error("Invalid ZIP directory")
  const files = new Map<string, Uint8Array>()
  let cursor = central
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry")
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24)
    const length = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32)
    const mode = (buffer.readUInt32LE(cursor + 38) >>> 16) & 0xf000, offset = buffer.readUInt32LE(cursor + 42)
    if (cursor + 46 + length + extra + comment > end) throw new Error("Invalid ZIP name")
    const name = buffer.subarray(cursor + 46, cursor + 46 + length).toString("utf8")
    cursor += 46 + length + extra + comment
    if (!wanted.includes(name)) continue
    if (files.has(name) || (flags & 1) || ![0, 8].includes(method) || (mode && mode !== 0x8000)
      || size > MAX_TRANSPORT_BYTES || offset + 30 > central || buffer.readUInt32LE(offset) !== 0x04034b50
      || buffer.readUInt16LE(offset + 8) !== method || (buffer.readUInt16LE(offset + 6) & 1)) throw new Error("Unsafe ZIP entry")
    const localLength = buffer.readUInt16LE(offset + 26), localExtra = buffer.readUInt16LE(offset + 28)
    const start = offset + 30 + localLength + localExtra
    if (start + compressed > central || buffer.subarray(offset + 30, offset + 30 + localLength).toString("utf8") !== name) throw new Error("Invalid ZIP data")
    const input = buffer.subarray(start, start + compressed)
    const data = method === 0 ? input : inflateRawSync(input, { maxOutputLength: MAX_TRANSPORT_BYTES })
    if (data.length !== size) throw new Error("Invalid ZIP size")
    files.set(name, data)
  }
  return files
}

export async function readTransportArchive(bytes: Uint8Array, component: TransportComponent) {
  if (bytes.length > MAX_TRANSPORT_BYTES || transportHash(bytes) !== component.archive.sha256) throw new TransportError("CONNECTOR_INTEGRITY_FAILED")
  try {
    const binaryName = component.archive.prefix + transportBinary(component), licenseName = component.archive.prefix + "LICENSE"
    let binary: Uint8Array | undefined, license: Uint8Array | undefined
    if (component.archive.format === "zip") {
      const files = zipFiles(bytes, [binaryName, licenseName])
      binary = files.get(binaryName); license = files.get(licenseName)
    } else {
      const files = await new Bun.Archive(gunzipSync(bytes, { maxOutputLength: MAX_TRANSPORT_BYTES * 3 })).files()
      const entry = files.get(binaryName), notice = files.get(licenseName)
      if (entry?.size === component.executable.size) binary = await entry.bytes()
      if (notice && notice.size <= 128 * 1024) license = await notice.bytes()
    }
    if (!binary || binary.length !== component.executable.size || transportHash(binary) !== component.executable.sha256
      || !license || license.length > 128 * 1024) throw new Error("Invalid component files")
    return { binary, license }
  } catch { throw new TransportError("CONNECTOR_INTEGRITY_FAILED") }
}

export async function downloadTransport(component: TransportComponent, fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch) {
  try {
    const response = await fetcher(component.archive.url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_TRANSPORT_BYTES) throw new Error()
    const chunks: Uint8Array[] = [], reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > MAX_TRANSPORT_BYTES) throw new Error()
        chunks.push(next.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return new Uint8Array(Buffer.concat(chunks, size))
  } catch { throw new TransportError("CONNECTOR_DOWNLOAD_FAILED") }
}
