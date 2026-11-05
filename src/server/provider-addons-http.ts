import { MAX_ADDON_BYTES } from "../shared/provider-addons"
import { SERVER_PROVIDERS } from "./provider-catalog"
import type { ProviderAddons } from "./provider-addons"
import { harnessConfigInputSchema, harnessDiscoverySchema } from "../shared/harness-models"

async function readBody(req: Request, limit: number) {
  const reader = req.body?.getReader()
  if (!reader) throw new Error("Missing add-on request.")
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const next = await reader.read(); if (next.done) break
    size += next.value.byteLength
    if (size > limit) { await reader.cancel(); throw new Error("Add-on request is too large.") }
    chunks.push(next.value)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export async function handleProviderAddons(req: Request, url: URL, addons: ProviderAddons, local: boolean) {
  if (url.pathname === "/api/addons/deepseek/models") {
    const headers = { "Cache-Control": "no-store" }
    if (!local || (req.method !== "GET" && req.headers.get("origin") !== url.origin)) return Response.json({ error: "Manage Harness configuration locally on the StillOn computer." }, { status: 403, headers })
    try {
      if (req.method === "GET") return Response.json({ ...addons.modelState("deepseek"), configuration: await addons.modelOperation("deepseek", "configuration") }, { headers })
      if (req.method !== "POST") return new Response(null, { status: 405, headers })
      const body = await readBody(req, 128 * 1024)
      if (body.action === "apply") return Response.json({ policy: await addons.selectModels("deepseek", body.selection) }, { headers })
      if (body.action === "discover") return Response.json({ models: await addons.modelOperation("deepseek", "discover", harnessDiscoverySchema.parse(body.input)) }, { headers })
      if (body.action === "configure" || body.action === "fetchModels") return Response.json({ result: await addons.modelOperation("deepseek", body.action, harnessConfigInputSchema.parse(body.input)) }, { headers })
      throw new Error("Unknown model operation.")
    } catch (error) {
      // Never echo schema input or vendor errors that could contain credentials.
      return Response.json({ error: error instanceof Error && !(error instanceof SyntaxError) && !error.name.includes("Zod") ? error.message : "Invalid Harness configuration." }, { status: 400, headers })
    }
  }
  if (url.pathname !== "/api/addons" && url.pathname !== "/api/providers") return null
  const headers = { "Cache-Control": "no-store" }
  if (req.method === "GET") return Response.json({ addons: url.pathname === "/api/addons" ? addons.snapshot() : [],
    providers: [...SERVER_PROVIDERS, ...addons.providers()], canManage: local }, { headers })
  if (url.pathname !== "/api/addons" || req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
  if (!local || req.headers.get("origin") !== url.origin) return Response.json({ error: "Manage add-ons locally on the StillOn computer." }, { status: 403, headers })
  try {
    const body = await readBody(req, MAX_ADDON_BYTES * 2)
    if (body.action === "install") await addons.install(body.package)
    else if (["enable", "disable", "uninstall", "rollback"].includes(body.action) && typeof body.id === "string") await addons.change(body.id, body.action)
    else throw new Error("Unknown add-on action.")
    return Response.json({ ok: true }, { headers })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to change add-on." }, { status: 400, headers }) }
}
