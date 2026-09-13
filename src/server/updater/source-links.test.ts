import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile, lstat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copySourceEntry, copyTree, manifest } from "./files"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-source-links-"))
  roots.push(root)
  await mkdir(path.join(root, ".agents/skills/shadcn"), { recursive: true })
  await mkdir(path.join(root, ".claude/skills"), { recursive: true })
  await writeFile(path.join(root, ".agents/skills/shadcn/SKILL.md"), "UI instructions")
  return root
}

test("the repository's shadcn link is recorded without traversing or flattening it", async () => {
  const root = await fixture()
  await symlink("../../.agents/skills/shadcn", path.join(root, ".claude/skills/shadcn"), "dir")
  const files = await manifest(root, true)
  expect(files[".claude/skills/shadcn"]).toBe("symlink:" + await readlink(path.join(root, ".claude/skills/shadcn")))
  expect(files[".agents/skills/shadcn/SKILL.md"]).toMatch(/^[a-f0-9]{64}$/)
  expect(files[".claude/skills/shadcn/SKILL.md"]).toBeUndefined()
  await expect(manifest(root)).rejects.toThrow("data or build")
  await expect(copyTree(root, path.join(root, "backup"))).rejects.toThrow("data or build")
})

test("additional internal file and directory links retain their text and type", async () => {
  const source = await fixture(), target = await fixture()
  await symlink("../../.agents/skills/shadcn", path.join(source, ".claude/skills/shadcn"), "dir")
  await symlink(".agents/skills/shadcn/SKILL.md", path.join(source, "instructions.md"), "file")
  for (const name of [".claude/skills/shadcn", "instructions.md"]) {
    await copySourceEntry(source, target, name)
    expect((await lstat(path.join(target, name))).isSymbolicLink()).toBe(true)
    expect(await readlink(path.join(target, name))).toBe(await readlink(path.join(source, name)))
  }
  expect(await manifest(target, true)).toEqual(await manifest(source, true))
  await expect(copySourceEntry(source, target, "instructions.md")).rejects.toThrow("overwrite")
})

test.each(["outside", "indirect", "absolute", "dangling", "cycle", "generated", "data"])("rejects %s links", async (kind) => {
  const root = await fixture(), other = await fixture()
  let target = "missing"
  if (kind === "outside") target = path.relative(root, path.join(other, ".agents"))
  if (kind === "absolute") target = path.join(root, ".agents")
  if (kind === "cycle") target = "link"
  if (kind === "indirect") {
    await symlink(path.relative(root, other), path.join(root, "bridge"), "dir")
    target = "bridge/.agents"
  }
  if (kind === "generated" || kind === "data") {
    const directory = kind === "generated" ? "node_modules" : ".stillon"
    await mkdir(path.join(root, directory));await writeFile(path.join(root, directory, "private"), "do not copy")
    target = `${directory}/private`
  }
  await symlink(target, path.join(root, "link"), kind === "outside" || kind === "indirect" || kind === "absolute" ? "dir" : "file")
  await expect(manifest(root, true)).rejects.toThrow()
})

test("an extra file cannot write through a destination directory link", async () => {
  const source = await fixture(), target = await fixture(), outside = await fixture()
  await mkdir(path.join(source, "custom"));await writeFile(path.join(source, "custom/file"), "content")
  await symlink(outside, path.join(target, "custom"), "dir")
  await expect(copySourceEntry(source, target, "custom/file")).rejects.toThrow("Linked")
  expect(await readFile(path.join(outside, ".agents/skills/shadcn/SKILL.md"), "utf8")).toBe("UI instructions")
})


test("source links may reference nested assets named dist", async () => {
  const root = await fixture()
  await mkdir(path.join(root, "public/dist"), { recursive: true })
  await writeFile(path.join(root, "public/dist/icon.svg"), "icon")
  await symlink("public/dist/icon.svg", path.join(root, "icon.svg"), "file")
  const files = await manifest(root, true)
  expect(files["icon.svg"]).toBe("symlink:" + await readlink(path.join(root, "icon.svg")))
  expect(files["public/dist/icon.svg"]).toMatch(/^[a-f0-9]{64}$/)
})

test("extra files create missing nested parents from Git-style paths", async () => {
  const source = await fixture(), target = await fixture()
  await mkdir(path.join(source, "custom/deep"), { recursive: true })
  await writeFile(path.join(source, "custom/deep/file"), "custom asset")
  await copySourceEntry(source, target, "custom/deep/file")
  expect(await readFile(path.join(target, "custom/deep/file"), "utf8")).toBe("custom asset")
})
