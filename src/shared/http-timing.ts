/** Durations use each process's monotonic clock; no payloads or identifiers. */
export function appendHttpTiming<T extends Response | undefined>(response: T, stage: "host" | "connect" | "connect-auth", startedAt: number): T {
  if (!response) return response
  const timing = `${stage};dur=${Math.max(0, performance.now() - startedAt).toFixed(2)}`
  try { response.headers.append("Server-Timing", timing); return response }
  catch {
    const headers = new Headers(response.headers)
    headers.append("Server-Timing", timing)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers }) as T
  }
}
