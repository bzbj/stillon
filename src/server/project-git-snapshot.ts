import { createHash } from "node:crypto"
import type { ChatDiffSnapshot, ProjectGitSnapshotData } from "../shared/types"

// Leave room for the envelope below Connect's 1 MiB message limit.
export const INLINE_PROJECT_GIT_BYTES = 512 * 1024

export function projectGitSnapshotForTransport(snapshot: ChatDiffSnapshot | null, deferLargeSnapshots?: true): ProjectGitSnapshotData {
  if (!snapshot || !deferLargeSnapshots) return snapshot
  const serialized = JSON.stringify(snapshot)
  if (Buffer.byteLength(serialized) <= INLINE_PROJECT_GIT_BYTES) return snapshot
  return { deferred: true, revision: createHash("sha256").update(serialized).digest("hex") }
}

export function handleProjectGitSnapshotRequest(request: Request, url: URL, getSnapshot: (projectId: string) => ChatDiffSnapshot | null): Response | null {
  const match = /^\/api\/projects\/([^/]+)\/git-snapshot$/u.exec(url.pathname)
  if (!match) return null
  const headers = { "Cache-Control": "no-store" }
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } })
  let projectId: string
  try { projectId = decodeURIComponent(match[1]!) }
  catch { return Response.json({ error: "Invalid workspace" }, { status: 400, headers }) }
  const snapshot = getSnapshot(projectId)
  return snapshot ? Response.json(snapshot, { headers }) : Response.json({ error: "Workspace not found" }, { status: 404, headers })
}
