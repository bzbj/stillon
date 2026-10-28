export const SHARING_REFRESH_MS = 5 * 60_000

/** Display metadata only; authorization must never use this cache. */
export class SharingCache<T> {
  private value?: { data: T; at: number }
  private pending?: Promise<T>
  private generation = 0
  private failures = 0
  private retryAt = 0
  private error: unknown

  constructor(private readonly load: (force: boolean) => Promise<T>, private readonly now = Date.now) {}

  invalidate() {
    this.generation++
    this.pending = undefined
    this.value = undefined
    this.failures = this.retryAt = 0
  }

  set(data: T) {
    this.invalidate()
    this.value = { data, at: this.now() }
  }

  read(force = false): Promise<T> {
    if (this.pending) return this.pending
    if (!force && this.now() < this.retryAt) return Promise.reject(this.error)
    if (!force && this.value && this.now() - this.value.at < SHARING_REFRESH_MS) return Promise.resolve(this.value.data)
    const generation = this.generation
    const request = Promise.resolve().then(() => this.load(force)).then(data => {
      if (generation === this.generation) {
        this.value = { data, at: this.now() }
        this.failures = this.retryAt = 0
      }
      return data
    }, error => {
      if (generation === this.generation) {
        this.error = error
        this.retryAt = this.now() + SHARING_REFRESH_MS * 2 ** Math.min(this.failures++, 2)
      }
      throw error
    }).finally(() => { if (this.pending === request) this.pending = undefined })
    this.pending = request
    return request
  }
}
