import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultWorkspaceAvatars, workspaceAvatarChoice, workspaceAvatarsSchema } from "../shared/workspace-avatars"
import { handleWorkspaceAvatars, WorkspaceAvatarsManager } from "./workspace-avatars"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-avatars-")); directories.push(directory)
  return { directory, file: path.join(directory, "customizations/appearance/avatars.json"), manager: new WorkspaceAvatarsManager(directory) }
}

test("avatar identity stays stable and custom definitions contain vector data only", () => {
  const config = workspaceAvatarsSchema.parse(defaultWorkspaceAvatars())
  expect(workspaceAvatarChoice(config, "workspace-id")).toEqual(workspaceAvatarChoice(config, "workspace-id"))
  config.workspaces["workspace-id"] = { shape: "drop", color: "#abcdef" }
  expect(workspaceAvatarChoice(config, "workspace-id")).toEqual({ shape: "drop", color: "#abcdef" })
  for (const body of ['<svg onload="alert(1)">', "url(https://example.com)", "javascript:alert(1)"]) {
    expect(workspaceAvatarsSchema.safeParse({ ...config, shapes: [{ ...config.shapes[0], body }] }).success).toBe(false)
  }
  expect(workspaceAvatarsSchema.safeParse({ ...config, palette: ["red;display:none"] }).success).toBe(false)
})

test("avatar choices survive restart; UI writes preserve hand-edited shapes and palette", async () => {
  const { directory, file, manager } = await fixture()
  const initial = (await manager.snapshot()).config
  initial.shapes.push({ ...initial.shapes[0]!, id: "personal", label: "My shape", body: "M8 8h48v48H8Z" })
  initial.palette = ["#112233", "#456789"]
  await writeFile(file, JSON.stringify(initial))
  await Promise.all([
    manager.set("finance", { shape: "personal", color: "#112233" }),
    manager.set("writing", { shape: "drop", color: "#aabbcc" }),
  ])
  const restarted = await new WorkspaceAvatarsManager(directory).snapshot()
  expect(restarted.warning).toBeUndefined()
  expect(restarted.config.shapes.at(-1)?.id).toBe("personal")
  expect(restarted.config.palette).toEqual(["#112233", "#456789"])
  expect(restarted.config.workspaces).toEqual({ finance: { shape: "personal", color: "#112233" }, writing: { shape: "drop", color: "#aabbcc" } })
})

test("malformed user files retain the last good UI and are never silently overwritten", async () => {
  const { file, manager } = await fixture()
  await manager.set("finance", { shape: "drop", color: "#123456" })
  const valid = await readFile(file, "utf8")
  await writeFile(file, "{editing")
  const snapshot = await manager.snapshot()
  expect(snapshot.warning).toContain("avatars.json")
  expect(snapshot.config.workspaces.finance?.color).toBe("#123456")
  await expect(manager.set("writing", { shape: "round", color: "#112233" })).rejects.toThrow()
  expect(await readFile(file, "utf8")).toBe("{editing")
  await writeFile(file, valid)
  expect((await manager.snapshot()).warning).toBeUndefined()
})

test.skipIf(process.platform === "win32")("avatar files cannot redirect reads or writes through symlinks", async () => {
  const { directory, file, manager } = await fixture()
  await manager.snapshot(); await rm(file)
  const outside = path.join(directory, "private.json")
  await writeFile(outside, JSON.stringify(defaultWorkspaceAvatars()))
  await symlink(outside, file)
  expect((await manager.snapshot()).warning).toBeDefined()
  await expect(manager.set("finance", { shape: "round", color: "#112233" })).rejects.toThrow()
  expect(JSON.parse(await readFile(outside, "utf8")).workspaces).toEqual({})
})

test("avatar HTTP mutations require origin and an existing workspace, and bound the body", async () => {
  const { manager } = await fixture(), origin = "http://localhost:3210"
  const options = { validateOrigin: (request: Request) => request.headers.get("origin") === origin, workspaceExists: (id: string) => id === "finance" }
  const post = (body: unknown, from = origin) => handleWorkspaceAvatars(new Request(origin + "/api/appearance/avatars", { method: "POST", headers: { origin: from }, body: JSON.stringify(body) }), manager, options)
  expect((await post({ workspaceId: "finance", shape: "round", color: "#112233" }, "null"))?.status).toBe(403)
  expect((await post({ workspaceId: "unknown", shape: "round", color: "#112233" }))?.status).toBe(404)
  expect((await post({ workspaceId: "finance", shape: "missing", color: "#112233" }))?.status).toBe(400)
  expect((await post({ workspaceId: "finance", shape: "drop", color: "#112233" }))?.status).toBe(200)
  expect((await post({ workspaceId: "finance", color: "x".repeat(4096) }))?.status).toBe(400)
  const snapshot = (await handleWorkspaceAvatars(new Request(origin + "/api/appearance/avatars"), manager, options))!
  expect(snapshot.headers.get("cache-control")).toBe("no-store")
  expect((await snapshot.json()).config.workspaces.finance).toEqual({ shape: "drop", color: "#112233" })
})
