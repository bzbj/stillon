import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createProjectDirectory, ensureProjectDirectory, resolveLocalPathForPlatform } from "./paths"

describe("resolveLocalPathForPlatform", () => {
  test("resolves a home-relative project path on macOS and Linux", () => {
    expect(resolveLocalPathForPlatform("~/StillOn/my-project", "/Users/alice", path.posix))
      .toBe("/Users/alice/StillOn/my-project")
  })

  test("resolves slash and backslash home-relative paths on Windows", () => {
    const homeDirectory = "C:\\Users\\Alice"

    expect(resolveLocalPathForPlatform("~/StillOn/my-project", homeDirectory, path.win32))
      .toBe("C:\\Users\\Alice\\StillOn\\my-project")
    expect(resolveLocalPathForPlatform("~\\StillOn\\my-project", homeDirectory, path.win32))
      .toBe("C:\\Users\\Alice\\StillOn\\my-project")
  })

  test("keeps native absolute paths absolute", () => {
    expect(resolveLocalPathForPlatform("/Users/alice/StillOn", "/Users/alice", path.posix))
      .toBe("/Users/alice/StillOn")
    expect(resolveLocalPathForPlatform("C:\\Users\\Alice\\StillOn", "C:\\Users\\Alice", path.win32))
      .toBe("C:\\Users\\Alice\\StillOn")
  })

  test("rejects blank paths", () => {
    expect(() => resolveLocalPathForPlatform("  ", "/Users/alice", path.posix))
      .toThrow("Workspace path is required")
  })
})


describe("workspace folder operations", () => {
  test("opening a missing folder does not create it", async () => {
    const {mkdtemp,rm,stat}=await import("node:fs/promises")
    const {tmpdir}=await import("node:os")
    const root=await mkdtemp(path.join(tmpdir(),"stillon-workspace-"))
    const target=path.join(root,"missing")
    try {
      await expect(ensureProjectDirectory(target)).rejects.toThrow("Folder not found")
      await expect(stat(target)).rejects.toHaveProperty("code","ENOENT")
    } finally { await rm(root,{recursive:true,force:true}) }
  })
  test("creation preserves Chinese and spaces, and rejects existing folders without changing files", async () => {
    const {mkdtemp,rm,writeFile,readFile}=await import("node:fs/promises")
    const {tmpdir}=await import("node:os")
    const root=await mkdtemp(path.join(tmpdir(),"stillon-workspace-"))
    const target=path.join(root,"财务分析 2026")
    try {
      await createProjectDirectory(target)
      await ensureProjectDirectory(target)
      await writeFile(path.join(target,"notes.txt"),"keep")
      await expect(createProjectDirectory(target)).rejects.toThrow("Folder already exists")
      expect(await readFile(path.join(target,"notes.txt"),"utf8")).toBe("keep")
    } finally { await rm(root,{recursive:true,force:true}) }
  })
})
