/** Bun 1.3.14 can retain a stale WebSocket count after server-side close:
 * https://github.com/oven-sh/bun/issues/36223
 * Force-close the listener/connections, but do not wait forever on that counter.
 * Callers still drain their own work before closing databases. */
export async function stopConnectListener(server: { stop(closeActiveConnections: boolean): Promise<void>; unref(): void }) {
  const stopped = server.stop(true)
  await Promise.race([stopped, Bun.sleep(1_000)])
  server.unref()
}
