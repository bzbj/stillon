import { randomUUID } from "node:crypto"
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { defaultWorkspaceAvatars, workspaceAvatarChoiceSchema, workspaceAvatarsSchema, type WorkspaceAvatars, type WorkspaceAvatarsSnapshot } from "../shared/workspace-avatars"
import { appearanceDirectory, boundedBody } from "./appearance-assets"

export class WorkspaceAvatarsManager {
  private last = defaultWorkspaceAvatars()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly dataDir: string) {}

  private async file() {
    const directory = await appearanceDirectory(this.dataDir, null, true)
    const filePath = path.join(directory, "avatars.json")
    await writeFile(filePath, JSON.stringify(defaultWorkspaceAvatars(), null, 2) + "\n", { flag: "wx", mode: 0o600 })
      .catch(error => { if (error.code !== "EEXIST") throw error })
    return filePath
  }

  private async read(): Promise<WorkspaceAvatars> {
    const filePath = await this.file(), info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error("Invalid avatar file.")
    const parsed = workspaceAvatarsSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")))
    if (!parsed.success) throw new Error("Invalid avatar settings.")
    this.last = parsed.data
    return parsed.data
  }

  async snapshot(): Promise<WorkspaceAvatarsSnapshot> {
    try { return { config: await this.read() } }
    catch { return { config: this.last, warning: "Unable to read avatars.json. Fix the file and reload to use your custom avatars." } }
  }

  set(workspaceId: string, input: unknown) {
    const operation = this.pending.then(async () => {
      const choice = workspaceAvatarChoiceSchema.parse(input)
      const config = await this.read()
      const next = workspaceAvatarsSchema.parse({ ...config, workspaces: { ...config.workspaces, [workspaceId]: choice } })
      const filePath = await this.file(), temporary = `${filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 })
        await rename(temporary, filePath)
      } finally { await unlink(temporary).catch(() => {}) }
      this.last = next
      return { config: next }
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}

export async function handleWorkspaceAvatars(request: Request, manager: WorkspaceAvatarsManager, options: {
  validateOrigin: (request: Request) => boolean; workspaceExists: (id: string) => boolean
}) {
  if (new URL(request.url).pathname !== "/api/appearance/avatars") return null
  const headers = { "Cache-Control": "no-store" }
  if (request.method === "GET") return Response.json(await manager.snapshot(), { headers })
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
  if (!options.validateOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403, headers })
  try {
    const text = (await boundedBody(request, 2048)).toString("utf8")
    const input = JSON.parse(text)
    if (typeof input.workspaceId !== "string" || !options.workspaceExists(input.workspaceId)) return Response.json({ error: "Workspace not found." }, { status: 404 })
    return Response.json(await manager.set(input.workspaceId, { shape: input.shape, color: input.color }), { headers })
  } catch { return Response.json({ error: "Unable to save this avatar. Check the selection and avatars.json, then retry." }, { status: 400, headers }) }
}
