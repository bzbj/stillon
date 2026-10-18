import type { Socket } from "bun"

/** Read bounded HTTP metadata over an actual loopback socket. Bun's HTTP client
 * can ignore createConnection/Agent overrides and re-resolve localhost instead. */
export function probeLoopbackHttp(url: URL, host: "127.0.0.1" | "::1", signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let connection: Socket | undefined
    let settled = false, pending = Buffer.alloc(0), status = 0
    let headers: Headers | undefined, remaining: number | undefined, chunked = false, chunkRemaining = -1
    const chunks: Buffer[] = []
    let bytes = 0, wireBytes = 0
    const close = () => { signal.removeEventListener("abort", abort); connection?.terminate() }
    const fail = (error: Error) => { if (!settled) { settled = true; close(); reject(error) } }
    const abort = () => fail(new Error("Local service discovery timed out"))
    const finish = () => {
      if (settled) return
      settled = true; close()
      try { resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })) }
      catch (error) { reject(error) }
    }
    const body = (data: Buffer) => {
      const part = data.subarray(0, 64 * 1024 - bytes)
      chunks.push(part); bytes += part.length
      if (bytes >= 64 * 1024 || (headers?.get("content-type")?.includes("text/html") && /<\/title\s*>/iu.test(Buffer.concat(chunks).toString("utf8")))) finish()
    }
    const consume = (value: Buffer) => {
      if (settled) return
      const data = Buffer.from(value)
      wireBytes += data.length
      if (wireBytes > 256 * 1024) { fail(new Error("Local HTTP metadata exceeds its limit")); return }
      pending = Buffer.concat([pending, data])
      if (!headers) {
        const end = pending.indexOf("\r\n\r\n")
        if (end < 0) { if (pending.length > 16 * 1024) fail(new Error("Local HTTP headers exceed their limit")); return }
        if (end > 16 * 1024) { fail(new Error("Local HTTP headers exceed their limit")); return }
        const lines = pending.subarray(0, end).toString("latin1").split("\r\n")
        const match = /^HTTP\/1\.[01] (\d{3})\b/u.exec(lines.shift() ?? "")
        if (!match || Number(match[1]) < 200 || Number(match[1]) > 599) { fail(new Error("Invalid local HTTP response")); return }
        status = Number(match[1]); headers = new Headers()
        try {
          for (const line of lines) {
            const colon = line.indexOf(":")
            if (colon <= 0) throw new Error("Invalid local HTTP header")
            headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
          }
        } catch (error) { fail(error as Error); return }
        pending = pending.subarray(end + 4)
        if ([204, 205, 304].includes(status) || (status >= 300 && status < 400 && headers.has("location"))) { finish(); return }
        chunked = /(?:^|,)\s*chunked\s*$/iu.test(headers.get("transfer-encoding") ?? "")
        const length = headers.get("content-length")
        if (!chunked && length !== null) {
          if (!/^\d+$/u.test(length)) { fail(new Error("Invalid local HTTP length")); return }
          remaining = Number(length)
        }
      }
      if (!chunked) {
        const length = Math.min(pending.length, remaining ?? pending.length)
        body(pending.subarray(0, length)); pending = Buffer.alloc(0)
        if (remaining !== undefined) { remaining -= length; if (remaining === 0) finish() }
        return
      }
      while (!settled) {
        if (chunkRemaining === -1) {
          const end = pending.indexOf("\r\n")
          if (end < 0) { if (pending.length > 128) fail(new Error("Invalid local HTTP chunk")); return }
          const line = pending.subarray(0, end).toString("ascii")
          if (!/^[\da-f]+(?:;.*)?$/iu.test(line)) { fail(new Error("Invalid local HTTP chunk")); return }
          chunkRemaining = parseInt(line, 16); pending = pending.subarray(end + 2)
          if (!Number.isSafeInteger(chunkRemaining)) { fail(new Error("Invalid local HTTP chunk")); return }
          if (chunkRemaining === 0) { finish(); return }
        }
        if (chunkRemaining > 0) {
          const length = Math.min(chunkRemaining, pending.length)
          body(pending.subarray(0, length)); pending = pending.subarray(length); chunkRemaining -= length
          if (chunkRemaining > 0) return
        }
        if (pending.length < 2) return
        if (pending[0] !== 13 || pending[1] !== 10) { fail(new Error("Invalid local HTTP chunk ending")); return }
        pending = pending.subarray(2); chunkRemaining = -1
      }
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) { abort(); return }
    void Bun.connect({ hostname: host, port: Number(url.port || 80), socket: {
      open(socket) {
        connection = socket
        if (settled) { socket.terminate(); return }
        socket.timeout(1)
        socket.write(`GET ${url.pathname}${url.search} HTTP/1.0\r\nHost: ${url.host}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`)
      },
      data(_socket, value) { consume(value) },
      connectError(_socket, error) { fail(error) },
      error(_socket, error) { fail(error) },
      timeout() { fail(new Error("Local service discovery timed out")) },
      close() { if (!settled) { if (headers) finish(); else fail(new Error("Local HTTP connection closed")) } },
    } }).catch(fail)
  })
}
