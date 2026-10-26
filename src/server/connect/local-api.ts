import type { createConnector } from "./connector"
import { ConnectorError } from "./connector"
import type { Ingress } from "./ingress"

async function sessionBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 256) { await reader.cancel(); return null }
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as { sessionId?: unknown } | null
  } catch { return null }
}

export async function handleConnectLocal(request: Request, ingress: Ingress, connector: Awaited<ReturnType<typeof createConnector>> | null) {
  const route = new URL(request.url).pathname
  if (!route.startsWith("/api/connect-local/")) return null
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (ingress.kind !== "local") return json({ error: "LOCAL_ONLY" }, 403)
  if (!connector) return json({ error: "CONNECTOR_STARTING" }, 503)
  if (route === "/api/connect-local/status" && request.method === "GET") return json(connector.status())
  if (route === "/api/connect-local/diagnostics" && request.method === "GET") return json(connector.diagnostics())
  if ((route === "/api/connect-local/sessions" && request.method === "GET") || (route === "/api/connect-local/sessions/revoke" && request.method === "POST")) {
    try {
      if (request.method === "GET") return json(await connector.browserSessions())
      const body = await sessionBody(request)
      if (!body || typeof body.sessionId !== "string" || !/^[\w-]{1,128}$/.test(body.sessionId) || Object.keys(body).length !== 1) return json({ error: "INVALID_BODY" }, 400)
      return json(await connector.revokeBrowserSession(body.sessionId))
    } catch (error) {
      return json({ error: error instanceof ConnectorError ? error.code : "SERVICE_UNAVAILABLE" }, error instanceof ConnectorError ? error.status : 503)
    }
  }
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405)
  // No caller-supplied URL, private key, port or cloud credential is accepted.
  if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 32) return json({ error: "INVALID_BODY" }, 400)
  try {
    switch (route) {
      case "/api/connect-local/repair-transport": await connector.repairTransport(); break
      case "/api/connect-local/enroll": return json(await connector.enroll())
      case "/api/connect-local/pause": await connector.pause(); break
      case "/api/connect-local/resume": await connector.resume(); break
      case "/api/connect-local/unbind": await connector.unbind(); break
      default: return json({ error: "NOT_FOUND" }, 404)
    }
    return json(connector.status())
  } catch (error) { return json({ error: error instanceof ConnectorError ? error.code : "SERVICE_UNAVAILABLE" }, error instanceof ConnectorError ? error.status : 503) }
}
