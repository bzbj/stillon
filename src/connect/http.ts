import { ConnectFault } from "./registry"

export function json(body: unknown, status = 200, headers = new Headers()) {
  headers.set("Cache-Control", "no-store")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "no-referrer")
  return Response.json(body, { status, headers })
}
export function faultResponse(error: unknown) {
  const fault = error instanceof ConnectFault ? error : new ConnectFault("SERVICE_UNAVAILABLE", 503)
  const headers = new Headers()
  if (fault.retryAfterSeconds) headers.set("Retry-After", String(fault.retryAfterSeconds))
  return json({ error: fault.code, requestId: crypto.randomUUID(), ...(fault.retryAfterSeconds ? { retryAfterSeconds: fault.retryAfterSeconds } : {}) }, fault.status, headers)
}
export function checkBrowserRequest(request: Request, origin: string) {
  const url = new URL(request.url)
  if (url.host !== new URL(origin).host || (request.headers.has("host") && request.headers.get("host") !== url.host)) throw new ConnectFault("INVALID_HOST", 403)
  const from = request.headers.get("origin")
  const navigation = request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-dest") === "document"
  if ((from && from !== origin) || (!navigation && ["same-site", "cross-site"].includes(request.headers.get("sec-fetch-site") ?? ""))
    || ((!["GET", "HEAD"].includes(request.method) || request.headers.get("upgrade")?.toLowerCase() === "websocket") && from !== origin)) throw new ConnectFault("INVALID_ORIGIN", 403)
}
export async function jsonBody(request: Request, max = 4_096): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new ConnectFault("INVALID_BODY", 400)
  const reader = request.body?.getReader()
  if (!reader) throw new ConnectFault("INVALID_BODY", 400)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length
      if (total > max) { await reader.cancel(); throw new ConnectFault("BODY_TOO_LARGE", 413) }; chunks.push(next.value) }
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch (error) { if (error instanceof ConnectFault) throw error; throw new ConnectFault("INVALID_BODY", 400) }
}
export function cookieValue(request: Request, name: string) {
  const parts = (request.headers.get("cookie") ?? "").split(";").map(p => p.trim()).filter(p => p.startsWith(`${name}=`))
  return parts.length === 1 ? parts[0]!.slice(name.length + 1) : ""
}
export function cookieName(origin: string, kind: string) { return `${origin.startsWith("https:") ? "__Host-" : ""}stillon-connect.${kind}` }
export function cookie(origin: string, kind: string, value: string, maxAge?: number) {
  return `${cookieName(origin, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax${origin.startsWith("https:") ? "; Secure" : ""}${maxAge === undefined ? "" : `; Max-Age=${Math.max(0, Math.floor(maxAge))}`}`
}
export function redirect(location: string, headers = new Headers()) { headers.set("Location", location); headers.set("Cache-Control", "no-store"); headers.set("Referrer-Policy", "no-referrer"); return new Response(null, { status: 303, headers }) }
