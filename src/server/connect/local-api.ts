import type { createConnector } from "./connector"
import { ConnectorError } from "./connector"
import type { Ingress } from "./ingress"

export async function handleConnectLocal(request: Request, ingress: Ingress, connector: Awaited<ReturnType<typeof createConnector>> | null) {
  const route = new URL(request.url).pathname
  if (!route.startsWith("/api/connect-local/")) return null
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (ingress.kind !== "local") return json({ error: "LOCAL_ONLY" }, 403)
  if (!connector) return json({ error: "CONNECTOR_STARTING" }, 503)
  if (route === "/api/connect-local/status" && request.method === "GET") return json(connector.status())
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405)
  // No caller-supplied URL, private key, port or cloud credential is accepted.
  if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 32) return json({ error: "INVALID_BODY" }, 400)
  try {
    switch (route) {
      case "/api/connect-local/enroll": return json(await connector.enroll())
      case "/api/connect-local/pause": await connector.pause(); break
      case "/api/connect-local/resume": await connector.resume(); break
      case "/api/connect-local/unbind": await connector.unbind(); break
      default: return json({ error: "NOT_FOUND" }, 404)
    }
    return json(connector.status())
  } catch (error) { return json({ error: error instanceof ConnectorError ? error.code : "SERVICE_UNAVAILABLE" }, error instanceof ConnectorError ? error.status : 503) }
}
