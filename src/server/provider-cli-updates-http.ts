import type { AgentProvider } from "../shared/types"
import type { ProviderCliUpdates } from "./provider-cli-updates"

export async function handleProviderCliUpdates(req: Request, url: URL, updates: ProviderCliUpdates, validateOrigin: (req: Request) => boolean) {
  if (!url.pathname.startsWith("/api/provider-cli-updates/")) return null
  const match = /^\/api\/provider-cli-updates\/(codex|claude)$/u.exec(url.pathname)
  async function reject(message: string, status: number) {
    // Consume rejected POST bodies before a Connect tunnel reuses the stream.
    await req.arrayBuffer().catch(() => undefined)
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
  }
  if (!match) return reject("Unknown provider.", 404)
  if (!["GET", "POST"].includes(req.method)) return reject("Method not allowed.", 405)
  if (req.method === "POST" && !validateOrigin(req)) return reject("Forbidden", 403)
  const provider = match[1] as AgentProvider
  try {
    if (req.method === "GET") return Response.json(await updates.status(provider, url.searchParams.get("refresh") === "1"), { headers: { "Cache-Control": "no-store" } })
    const text = await req.text()
    if (text.length > 512) return reject("Invalid update request.", 400)
    const body = JSON.parse(text)
    if (!body || typeof body.updateToken !== "string" || body.updateToken.length > 100 || Object.keys(body).some(key => key !== "updateToken")) return reject("Invalid update request.", 400)
    return Response.json(await updates.start(provider, body.updateToken), { status: 202, headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return Response.json({ error: error instanceof SyntaxError ? "Invalid update request." : error instanceof Error ? error.message : "Unable to check this CLI." }, { status: req.method === "POST" ? 409 : 400, headers: { "Cache-Control": "no-store" } })
  }
}
