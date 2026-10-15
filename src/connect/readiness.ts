/** A bounded dependency probe, distinct from process liveness. No email is sent. */
export function createReadinessProbe(checkStorage: () => void, upstreamOrigin?: string, now = Date.now) {
  let expiresAt = 0
  let pending: Promise<boolean> | undefined
  return () => {
    if (pending && now() < expiresAt) return pending
    expiresAt = now() + 5_000
    pending = (async () => {
      try {
        checkStorage()
        if (upstreamOrigin) {
          // An unknown virtual host normally returns 404 from frps. Reject
          // redirects and server errors; never follow a dependency off-host.
          const response = await fetch(new URL("/", upstreamOrigin), { method: "HEAD", headers: { Host: "readiness.invalid" },
            redirect: "error", signal: AbortSignal.timeout(1_500) })
          await response.body?.cancel()
          if (response.status >= 500) return false
        }
        return true
      } catch { return false }
    })()
    return pending
  }
}
