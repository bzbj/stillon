// Opt-in transport underneath protocol 1. Old peers continue to exchange JSON.
// Four <=192 KiB frames fit through the original Connect 1 MiB/2 MiB relay.
export const SOCKET_TRANSPORT_QUERY = "stillonTransport"
export const SOCKET_TRANSPORT_READY = "~stillon/ready/1"
const CHUNK = "~stillon/chunk/1 "
const ACK = "~stillon/ack/1 "
const CHUNK_CHARS = 64 * 1024
const WINDOW = 4
const MAX_MESSAGE_CHARS = 110 * 1024 * 1024

interface Transfer {
  id: number
  text: string
  offset: number
  next: number
  acknowledged: number
}

export class SocketTransport {
  private enabled: boolean
  private decided: boolean
  private probing = false
  private disposed = false
  private queue: string[] = []
  private controls: string[] = []
  private outgoing?: Transfer
  private incoming?: { id: number; next: number; parts: string[]; chars: number }
  private nextId = 1
  private lastIncomingId = 0
  private retry?: ReturnType<typeof setTimeout>
  private deadline?: ReturnType<typeof setTimeout>

  constructor(private readonly options: {
    enabled?: boolean
    // false means the frame was NOT accepted; buffered frames return true.
    write: (frame: string) => boolean
    fail: (reason: string) => void
    probe?: () => void
    timeoutMs?: number
  }) {
    this.enabled = options.enabled ?? false
    this.decided = this.enabled
  }

  get busy() { return Boolean(this.outgoing || this.queue.length) }

  send(text: string) {
    if (this.disposed) return
    if (text.length > MAX_MESSAGE_CHARS) { this.fail("Message exceeds transport capacity"); return }
    this.queue.push(text)
    if (!this.decided && !this.probing && text.length > CHUNK_CHARS) {
      this.probing = true
      this.options.probe?.()
    }
    this.flush()
  }

  // Returns only complete application messages. A partial command never runs.
  receive(raw: string): string | null {
    if (this.disposed) return null
    if (raw === SOCKET_TRANSPORT_READY) {
      this.enabled = this.decided = true
      this.flush()
      return null
    }
    if (!this.decided) { this.decided = true; this.flush() }
    if (!raw.startsWith("~stillon/")) {
      if (this.incoming) { this.fail("Interrupted transport message"); return null }
      return raw
    }
    if (!this.enabled) { this.fail("Unnegotiated transport frame"); return null }
    try {
      if (raw.startsWith(ACK)) {
        const match = /^(\d+):(\d+)$/.exec(raw.slice(ACK.length))
        const current = this.outgoing
        if (!match || !current || Number(match[1]) !== current.id
          || Number(match[2]) !== current.acknowledged + 1 || Number(match[2]) >= current.next) throw new Error()
        current.acknowledged++
        this.clearDeadline()
        if (current.offset === current.text.length && current.acknowledged === current.next - 1) this.outgoing = undefined
        this.flush()
        return null
      }
      if (!raw.startsWith(CHUNK) || raw.length > CHUNK_CHARS * 2 + 256) throw new Error()
      const frame = JSON.parse(raw.slice(CHUNK.length)) as { id: number; part: number; last: boolean; text: string }
      if (!Number.isSafeInteger(frame.id) || frame.id <= 0 || !Number.isSafeInteger(frame.part)
        || typeof frame.last !== "boolean" || typeof frame.text !== "string" || frame.text.length > CHUNK_CHARS || !frame.text.length) throw new Error()
      if (!this.incoming) {
        if (frame.part !== 0 || frame.id !== this.lastIncomingId + 1) throw new Error()
        this.incoming = { id: frame.id, next: 0, parts: [], chars: 0 }
      }
      const current = this.incoming
      if (frame.id !== current.id || frame.part !== current.next++) throw new Error()
      current.chars += frame.text.length
      if (current.chars > MAX_MESSAGE_CHARS) throw new Error()
      current.parts.push(frame.text)
      // Acknowledgements bypass the application queue, preventing a deadlock
      // when both sides are sending large envelopes at the same time.
      this.writeControl(ACK + `${frame.id}:${frame.part}`)
      if (!frame.last) return null
      this.incoming = undefined
      this.lastIncomingId = frame.id
      return current.parts.join("")
    } catch { this.fail("Invalid transport frame"); return null }
  }

  private writeControl(frame: string) {
    this.controls.push(frame)
    this.flush()
  }

  private flush() {
    if (this.disposed) return
    while (this.controls.length) {
      if (!this.options.write(this.controls[0]!)) { this.scheduleRetry(); return }
      this.controls.shift()
    }
    while (!this.outgoing && this.queue.length) {
      const text = this.queue[0]!
      if (!this.decided && text.length > CHUNK_CHARS) return
      if (!this.enabled || text.length <= CHUNK_CHARS) {
        if (!this.options.write(text)) { this.scheduleRetry(); return }
        this.queue.shift()
        this.clearDeadline()
      } else {
        this.queue.shift()
        this.outgoing = { id: this.nextId++, text, offset: 0, next: 0, acknowledged: -1 }
      }
    }
    const current = this.outgoing
    if (current) {
      while (current.next - current.acknowledged - 1 < WINDOW && current.offset < current.text.length) {
        let end = Math.min(current.offset + CHUNK_CHARS, current.text.length)
        // Never split a surrogate pair, including non-BMP document text.
        if (end < current.text.length && /[\uD800-\uDBFF]/.test(current.text[end - 1]!)) end--
        const frame = CHUNK + JSON.stringify({ id: current.id, part: current.next, last: end === current.text.length, text: current.text.slice(current.offset, end) })
        if (!this.options.write(frame)) { this.scheduleRetry(); return }
        current.offset = end
        current.next++
      }
      this.armDeadline()
    } else if (!this.queue.length) this.clearDeadline()
  }

  private scheduleRetry() {
    this.armDeadline()
    if (this.retry) return
    this.retry = setTimeout(() => { this.retry = undefined; this.flush() }, 25)
  }
  private armDeadline() {
    this.deadline ??= setTimeout(() => this.fail("Transport stopped making progress"), this.options.timeoutMs ?? 30_000)
  }
  private clearDeadline() { if (this.deadline) clearTimeout(this.deadline); this.deadline = undefined }
  private fail(reason: string) { this.dispose(); this.options.fail(reason) }
  dispose() {
    this.disposed = true
    if (this.retry) clearTimeout(this.retry)
    this.clearDeadline()
    this.queue = []
    this.controls = []
    this.incoming = this.outgoing = undefined
  }
}
