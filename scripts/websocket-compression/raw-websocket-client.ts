import { createHash, randomBytes } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { constants, deflateRawSync, inflateRawSync } from "node:zlib"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n")
const PERMESSAGE_DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

export const DEFAULT_RAW_WEBSOCKET_TIMEOUT_MS = 3_000

export interface RawWebSocketConnectOptions {
  host?: string
  path?: string
  offerCompression?: boolean
  timeoutMs?: number
}

export interface RawWebSocketHandshake {
  statusCode: number
  statusLine: string
  headers: ReadonlyMap<string, readonly string[]>
  extensionNames: readonly string[]
}

export interface RawWebSocketFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  payloadBytes: number
  rsv1: boolean
  rsv2: boolean
  rsv3: boolean
  totalFrameBytes: number
}

export interface RawWebSocketMessage {
  compressed: boolean
  frameCount: number
  framePayloadBytes: number
  opcode: number
  payload: Buffer
  text: string
  totalFrameBytes: number
}

interface ClientFrameOptions {
  fin?: boolean
  opcode?: number
  rsv1?: boolean
}

class SocketByteReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private ended = false
  private failure: Error | null = null
  private wake: (() => void) | null = null

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer | string) => {
      const next = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next])
      this.signal()
    })
    socket.on("end", () => {
      this.ended = true
      this.signal()
    })
    socket.on("close", () => {
      this.ended = true
      this.signal()
    })
    socket.on("error", (error) => {
      this.failure = error
      this.signal()
    })
  }

  async readExactly(byteCount: number, timeoutMs: number): Promise<Buffer> {
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      throw new RangeError(`Invalid WebSocket byte count: ${byteCount}`)
    }
    await this.waitUntil(() => this.buffer.length >= byteCount, timeoutMs)
    const result = this.buffer.subarray(0, byteCount)
    this.buffer = this.buffer.subarray(byteCount)
    return result
  }

  async readUntil(marker: Buffer, maxBytes: number, timeoutMs: number): Promise<Buffer> {
    await this.waitUntil(() => {
      const markerIndex = this.buffer.indexOf(marker)
      if (markerIndex !== -1) {
        if (markerIndex + marker.length > maxBytes) {
          throw new Error(`WebSocket header exceeded ${maxBytes} bytes`)
        }
        return true
      }
      if (this.buffer.length > maxBytes) {
        throw new Error(`WebSocket header exceeded ${maxBytes} bytes`)
      }
      return false
    }, timeoutMs)

    const markerIndex = this.buffer.indexOf(marker)
    const endIndex = markerIndex + marker.length
    const result = this.buffer.subarray(0, endIndex)
    this.buffer = this.buffer.subarray(endIndex)
    return result
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (this.failure) throw this.failure
      if (this.ended) throw new Error("WebSocket connection closed before enough data arrived")

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for WebSocket data`)
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (this.wake === finish) this.wake = null
          resolve()
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          if (this.wake === finish) this.wake = null
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for WebSocket data`))
        }, remainingMs)
        this.wake = finish
      })
    }
  }

  private signal() {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

function parseHandshakeHeaders(rawHeaders: string) {
  const lines = rawHeaders.split("\r\n")
  const statusLine = lines.shift() ?? ""
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?:\s|$)/.exec(statusLine)
  if (!statusMatch) {
    throw new Error(`Invalid WebSocket upgrade status line: ${statusLine}`)
  }

  const headers = new Map<string, string[]>()
  for (const line of lines) {
    if (!line) continue
    const colonIndex = line.indexOf(":")
    if (colonIndex <= 0) throw new Error(`Invalid WebSocket upgrade header: ${line}`)
    const name = line.slice(0, colonIndex).trim().toLowerCase()
    const value = line.slice(colonIndex + 1).trim()
    const values = headers.get(name)
    if (values) values.push(value)
    else headers.set(name, [value])
  }

  return {
    headers,
    statusCode: Number(statusMatch[1]),
    statusLine,
  }
}

function parseExtensionNames(headers: ReadonlyMap<string, readonly string[]>) {
  return (headers.get("sec-websocket-extensions") ?? [])
    .flatMap((header) => header.split(","))
    .map((extension) => extension.split(";", 1)[0]?.trim().toLowerCase() ?? "")
    .filter(Boolean)
}

function encodePayloadLength(payloadBytes: number, masked: boolean) {
  const maskBit = masked ? 0x80 : 0
  if (payloadBytes <= 125) {
    return Buffer.from([maskBit | payloadBytes])
  }
  if (payloadBytes <= 0xffff) {
    const result = Buffer.allocUnsafe(3)
    result[0] = maskBit | 126
    result.writeUInt16BE(payloadBytes, 1)
    return result
  }
  if (!Number.isSafeInteger(payloadBytes)) {
    throw new RangeError(`WebSocket payload is too large: ${payloadBytes}`)
  }
  const result = Buffer.allocUnsafe(9)
  result[0] = maskBit | 127
  result.writeBigUInt64BE(BigInt(payloadBytes), 1)
  return result
}

export function encodeMaskedClientFrame(
  payload: string | Uint8Array,
  options: ClientFrameOptions = {},
) {
  const payloadBuffer = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload)
  const mask = randomBytes(4)
  const maskedPayload = Buffer.allocUnsafe(payloadBuffer.length)
  for (let index = 0; index < payloadBuffer.length; index++) {
    maskedPayload[index] = payloadBuffer[index]! ^ mask[index % mask.length]!
  }

  const fin = options.fin ?? true
  const opcode = options.opcode ?? 0x1
  const firstByte = (fin ? 0x80 : 0) | (options.rsv1 ? 0x40 : 0) | opcode
  return Buffer.concat([
    Buffer.from([firstByte]),
    encodePayloadLength(payloadBuffer.length, true),
    mask,
    maskedPayload,
  ])
}

export function deflatePerMessage(payload: string | Uint8Array) {
  const input = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload)
  const compressed = deflateRawSync(input, { finishFlush: constants.Z_SYNC_FLUSH })
  if (
    compressed.length >= PERMESSAGE_DEFLATE_TAIL.length &&
    compressed.subarray(-PERMESSAGE_DEFLATE_TAIL.length).equals(PERMESSAGE_DEFLATE_TAIL)
  ) {
    return compressed.subarray(0, -PERMESSAGE_DEFLATE_TAIL.length)
  }
  return compressed
}

export function inflatePerMessage(payload: Uint8Array) {
  return inflateRawSync(Buffer.concat([Buffer.from(payload), PERMESSAGE_DEFLATE_TAIL]), {
    finishFlush: constants.Z_SYNC_FLUSH,
  })
}

export class RawWebSocketClient {
  constructor(
    private readonly socket: Socket,
    private readonly reader: SocketByteReader,
    readonly handshake: RawWebSocketHandshake,
    private readonly timeoutMs: number,
  ) {}

  get negotiatedPerMessageDeflate() {
    return this.handshake.extensionNames.includes("permessage-deflate")
  }

  async readFrame(): Promise<RawWebSocketFrame> {
    const firstTwoBytes = await this.reader.readExactly(2, this.timeoutMs)
    const firstByte = firstTwoBytes[0]!
    const secondByte = firstTwoBytes[1]!
    const masked = (secondByte & 0x80) !== 0
    let payloadBytes = secondByte & 0x7f
    let extendedLengthBytes = 0

    if (payloadBytes === 126) {
      const extended = await this.reader.readExactly(2, this.timeoutMs)
      payloadBytes = extended.readUInt16BE(0)
      extendedLengthBytes = 2
    } else if (payloadBytes === 127) {
      const extended = await this.reader.readExactly(8, this.timeoutMs)
      const length = extended.readBigUInt64BE(0)
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`WebSocket frame is too large: ${length.toString()} bytes`)
      }
      payloadBytes = Number(length)
      extendedLengthBytes = 8
    }

    const mask = masked ? await this.reader.readExactly(4, this.timeoutMs) : null
    const payload = await this.reader.readExactly(payloadBytes, this.timeoutMs)
    if (mask) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] = payload[index]! ^ mask[index % mask.length]!
      }
    }

    return {
      fin: (firstByte & 0x80) !== 0,
      opcode: firstByte & 0x0f,
      payload,
      payloadBytes,
      rsv1: (firstByte & 0x40) !== 0,
      rsv2: (firstByte & 0x20) !== 0,
      rsv3: (firstByte & 0x10) !== 0,
      totalFrameBytes: 2 + extendedLengthBytes + (masked ? 4 : 0) + payloadBytes,
    }
  }

  async readMessage(): Promise<RawWebSocketMessage> {
    let opcode: number | null = null
    let compressed = false
    const fragments: Buffer[] = []
    let frameCount = 0
    let framePayloadBytes = 0
    let totalFrameBytes = 0

    while (true) {
      const frame = await this.readFrame()
      if (frame.rsv2 || frame.rsv3) throw new Error("Unexpected RSV2/RSV3 bit on WebSocket frame")

      if (frame.opcode === 0x8) {
        throw new Error("WebSocket peer sent a close frame before the next message")
      }
      if (frame.opcode === 0x9) {
        this.sendFrame(frame.payload, { opcode: 0x0a })
        continue
      }
      if (frame.opcode === 0x0a) continue

      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (opcode !== null) throw new Error("Received a new WebSocket message before FIN")
        opcode = frame.opcode
        compressed = frame.rsv1
      } else if (frame.opcode === 0x0) {
        if (opcode === null) throw new Error("Received a continuation frame without an initial frame")
        if (frame.rsv1) throw new Error("Continuation frame unexpectedly set RSV1")
      } else {
        throw new Error(`Unsupported WebSocket opcode: ${frame.opcode}`)
      }

      fragments.push(frame.payload)
      frameCount++
      framePayloadBytes += frame.payloadBytes
      totalFrameBytes += frame.totalFrameBytes
      if (!frame.fin) continue

      const encodedPayload = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)
      const payload = compressed ? inflatePerMessage(encodedPayload) : encodedPayload
      return {
        compressed,
        frameCount,
        framePayloadBytes,
        opcode,
        payload,
        text: payload.toString("utf8"),
        totalFrameBytes,
      }
    }
  }

  sendText(payload: string, options: { compress?: boolean } = {}) {
    if (options.compress) {
      if (!this.negotiatedPerMessageDeflate) {
        throw new Error("Cannot send a compressed frame without negotiating permessage-deflate")
      }
      this.sendFrame(deflatePerMessage(payload), { opcode: 0x1, rsv1: true })
      return
    }
    this.sendFrame(payload, { opcode: 0x1 })
  }

  sendClose(code = 1000) {
    const payload = Buffer.allocUnsafe(2)
    payload.writeUInt16BE(code, 0)
    this.sendFrame(payload, { opcode: 0x8 })
  }

  destroy() {
    this.socket.destroy()
  }

  private sendFrame(payload: string | Uint8Array, options: ClientFrameOptions) {
    if (this.socket.destroyed) throw new Error("Cannot write to a closed WebSocket")
    this.socket.write(encodeMaskedClientFrame(payload, options))
  }
}

export async function connectRawWebSocket(
  port: number,
  options: RawWebSocketConnectOptions = {},
): Promise<RawWebSocketClient> {
  const host = options.host ?? "127.0.0.1"
  const path = options.path ?? "/ws"
  const offerCompression = options.offerCompression ?? true
  const timeoutMs = options.timeoutMs ?? DEFAULT_RAW_WEBSOCKET_TIMEOUT_MS
  const key = randomBytes(16).toString("base64")
  const socket = createConnection({ host, port })
  const reader = new SocketByteReader(socket)

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out after ${timeoutMs} ms connecting to WebSocket server`))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off("connect", handleConnect)
        socket.off("error", handleError)
      }
      const handleConnect = () => {
        cleanup()
        resolve()
      }
      const handleError = (error: Error) => {
        cleanup()
        reject(error)
      }
      socket.once("connect", handleConnect)
      socket.once("error", handleError)
    })

    const requestHeaders = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ]
    if (offerCompression) {
      requestHeaders.push(
        "Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover",
      )
    }
    socket.write(`${requestHeaders.join("\r\n")}\r\n\r\n`)

    const rawHeaders = await reader.readUntil(HEADER_TERMINATOR, 64 * 1024, timeoutMs)
    const { headers, statusCode, statusLine } = parseHandshakeHeaders(
      rawHeaders.subarray(0, -HEADER_TERMINATOR.length).toString("latin1"),
    )
    if (statusCode !== 101) {
      throw new Error(`WebSocket upgrade failed: ${statusLine}`)
    }

    const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")
    const actualAccept = headers.get("sec-websocket-accept")?.[0]
    if (actualAccept !== expectedAccept) {
      throw new Error("WebSocket upgrade returned an invalid Sec-WebSocket-Accept header")
    }
    const upgradeHeader = headers.get("upgrade")?.join(",").toLowerCase()
    if (upgradeHeader !== "websocket") {
      throw new Error("WebSocket upgrade response omitted Upgrade: websocket")
    }

    const handshake: RawWebSocketHandshake = {
      headers,
      statusCode,
      statusLine,
      extensionNames: parseExtensionNames(headers),
    }
    return new RawWebSocketClient(socket, reader, handshake, timeoutMs)
  } catch (error) {
    socket.destroy()
    throw error
  }
}
