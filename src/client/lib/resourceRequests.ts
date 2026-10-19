let scope: string | null = null
let epoch = 0
const listeners = new Set<() => void>()
const pending = new Map<string, Promise<unknown>>()

export function setResourceSessionScope(next: string | null) {
  if (next === scope) return
  scope = next
  epoch++
  pending.clear()
  for (const listener of listeners) listener()
}
export const getResourceEpoch = () => epoch
export function subscribeResourceScope(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** In-flight sharing only. Every later action revalidates on the server. */
export function coalesceResourceRequest<T>(kind: string, address: string, projectId: string | undefined, load: () => Promise<T>): Promise<T> {
  const generation = epoch
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const key = JSON.stringify([origin, scope, generation, projectId ?? null, kind, address])
  const existing = pending.get(key)
  if (existing) return existing as Promise<T>
  const request = load().then(value => {
    if (generation !== epoch) throw new DOMException("Session changed. Retry this file action.", "AbortError")
    return value
  })
  pending.set(key, request)
  void request.finally(() => { if (pending.get(key) === request) pending.delete(key) }).catch(() => {})
  return request
}
