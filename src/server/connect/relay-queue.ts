type Message = string | ArrayBuffer | Buffer
const bytes = (message: Message) => typeof message === "string" ? Buffer.byteLength(message) : message.byteLength

// Generic preview sockets cannot negotiate the application's chunk protocol.
// Keep their frames intact, tolerate temporary pressure, and bound real backlog.
export class RelayQueue {
  private queue: Message[] = []
  private queuedBytes = 0
  private retry?: ReturnType<typeof setTimeout>
  private stalledAt = 0
  private previousBuffered = 0
  private closed = false
  private flushing = false

  constructor(private readonly sink: {
    write: (message: Message) => boolean
    buffered: () => number
    fail: () => void
    highWaterMark: number
    maxBacklog?: number
    stallMs?: number
  }) {}

  push(message: Message) {
    if (this.closed) return
    this.queuedBytes += bytes(message)
    if (this.queuedBytes + this.sink.buffered() > (this.sink.maxBacklog ?? 64 * 1024 * 1024)) { this.fail(); return }
    this.queue.push(message)
    this.flush()
  }

  flush() {
    if (this.closed || this.flushing) return
    this.flushing = true
    try {
      let buffered = this.sink.buffered()
      let progress = buffered < this.previousBuffered
      while (this.queue.length && buffered < this.sink.highWaterMark) {
        const message = this.queue[0]!
        if (!this.sink.write(message)) break
        this.queue.shift()
        this.queuedBytes -= bytes(message)
        progress = true
        buffered = this.sink.buffered()
      }
      this.previousBuffered = buffered
      if (!this.queue.length && !buffered) { this.stalledAt = 0; return }
      const now = Date.now()
      if (progress || !this.stalledAt) this.stalledAt = now
      if (now - this.stalledAt >= (this.sink.stallMs ?? 30_000)) { this.fail(); return }
      this.retry ??= setTimeout(() => { this.retry = undefined; this.flush() }, 25)
    } catch { this.fail() }
    finally { this.flushing = false }
  }

  private fail() { this.dispose(); this.sink.fail() }
  dispose() {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.queue = []
    this.queuedBytes = 0
  }
}
