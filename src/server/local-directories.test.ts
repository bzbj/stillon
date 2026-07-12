import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { listLocalDirectories } from "./local-directories"

describe("listLocalDirectories", () => {
  test("returns only direct child directories sorted before hidden entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-local-directories-"))
    const linkedTarget = await mkdtemp(path.join(tmpdir(), "kanna-local-directories-link-target-"))
    try {
      await mkdir(path.join(root, "beta", "nested"), { recursive: true })
      await mkdir(path.join(root, "alpha"), { recursive: true })
      await mkdir(path.join(root, ".hidden"), { recursive: true })
      await writeFile(path.join(root, "file.txt"), "not a directory", "utf8")
      await symlink(
        linkedTarget,
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : undefined,
      )

      const result = await listLocalDirectories(root)

      expect(result.path).toBe(root)
      expect(result.parentPath).toBe(path.dirname(root))
      expect(result.entries.map((entry) => entry.name)).toEqual(["alpha", "beta", "linked", ".hidden"])
      expect(result.entries.find((entry) => entry.name === "file.txt")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(linkedTarget, { recursive: true, force: true })
    }
  })

  test("rejects file paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-local-directories-"))
    try {
      const filePath = path.join(root, "file.txt")
      await writeFile(filePath, "not a directory", "utf8")

      await expect(listLocalDirectories(filePath)).rejects.toThrow("Path must be a directory")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
