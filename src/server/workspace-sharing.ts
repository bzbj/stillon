import type { createConnector } from "./connect/connector"
import { ConnectorError } from "./connect/connector"
import type { Ingress } from "./connect/ingress"
import type { EventStore } from "./event-store"
import { boundedBody } from "./appearance-assets"

export async function handleWorkspaceSharing(request: Request, ingress: Ingress, connector: Awaited<ReturnType<typeof createConnector>> | null, store: EventStore) {
  if (new URL(request.url).pathname !== "/api/workspace-sharing") return null
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
  if (ingress.kind === "remote" && ingress.workspaceId) return request.method === "GET"
    ? json({ mode: "guest", workspaceId: ingress.workspaceId, portalUrl: connector?.status().origin, workspaces: [] }) : json({ error: "OWNER_ONLY" }, 403)
  if (ingress.kind !== "local" && ingress.kind !== "remote") return json({ error: "OWNER_ONLY" }, 403)
  if (!connector) return json({ error: "CONNECTOR_STARTING" }, 503)
  if (!connector.status().hostId) return json({ mode: "owner", configured: false, workspaces: [] }, request.method === "GET" ? 200 : 409)
  try {
    if (request.method === "GET") return json({ mode: "owner", configured: true, ...await connector.workspaceSharing({ operation: "list" }, new URL(request.url).searchParams.get("refresh") === "1") })
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405)
    const input = JSON.parse((await boundedBody(request, 4096)).toString("utf8"))
    if (!input || !["invite", "remove", "stop"].includes(input.operation) || typeof input.workspaceId !== "string") return json({ error: "INVALID_BODY" }, 400)
    const project = store.getProject(input.workspaceId)
    if (!project) return json({ error: "WORKSPACE_NOT_FOUND" }, 404)
    const payload = { operation: input.operation, workspaceId: project.id, title: (project.sidebarTitle ?? project.title).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 256) || "Workspace",
      ...(input.operation === "invite" ? { email: input.email } : {}), ...(input.operation === "remove" ? { memberId: input.memberId } : {}) }
    const result = await connector.workspaceSharing(payload)
    return json({ mode: "owner", configured: true, ...result })
  } catch (error) { return json({ error: error instanceof ConnectorError ? error.code : "SHARING_UNAVAILABLE" }, error instanceof ConnectorError ? error.status : 503) }
}
