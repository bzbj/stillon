import type { AgentProvider } from "../shared/types"
import type { ProviderSetupStatus } from "../shared/provider-setup"
import type { ProviderCliSettings } from "./provider-cli-settings"

export async function handleProviderSetupRequest(req: Request, url: URL, options: {
  local: boolean; validateOrigin: (req: Request) => boolean; settings: Pick<ProviderCliSettings, "set">
  setup: { status: (provider: AgentProvider, local: boolean) => Promise<ProviderSetupStatus>; openTerminal: (provider: AgentProvider, action: "login" | "install") => Promise<unknown> }
}) {
  if (!url.pathname.startsWith("/api/provider-setup/")) return null
  const match = /^\/api\/provider-setup\/(codex|claude)\/(status|login|install|executable)$/u.exec(url.pathname)
  if (!match) return Response.json({ error: "Unknown Agent setup action." }, { status: 404 })
  const provider = match[1] as AgentProvider, action = match[2]!
  const method = action === "status" ? "GET" : "POST"
  if (req.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
  if (method === "POST" && (!options.local || !options.validateOrigin(req))) {
    return Response.json({ error: "Open StillOn locally on the Agent computer to install or sign in." }, { status: 403 })
  }
  try {
    if (action === "executable") {
      const body = await req.json()
      if (!(body.executable === null || typeof body.executable === "string" && body.executable.length <= 32768)) throw new Error("Choose a valid CLI executable path.")
      await options.settings.set(provider, body.executable)
    }
    const result = action === "login" || action === "install" ? await options.setup.openTerminal(provider, action) : await options.setup.status(provider, options.local)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to complete Agent setup." }, { status: 400 }) }
}
