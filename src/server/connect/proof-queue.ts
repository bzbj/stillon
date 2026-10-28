/** Keep challenge/request pairs serialized, but let heartbeats pass queued reads. */
export class ProofQueue {
  private jobs: { priority: number; run: () => Promise<void> }[] = []
  private running = false

  run<T>(operation: () => Promise<T>, priority = 1): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ priority, run: async () => { try { resolve(await operation()) } catch (error) { reject(error) } } })
      if (!this.running) {
        this.running = true
        queueMicrotask(() => { void this.drain() })
      }
    })
  }

  private async drain() {
    while (this.jobs.length) {
      this.jobs.sort((a, b) => a.priority - b.priority)
      await this.jobs.shift()!.run()
    }
    this.running = false
  }
}
