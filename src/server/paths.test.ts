import { describe, expect, test } from "bun:test"
import path from "node:path"
import { resolveLocalPathForPlatform } from "./paths"

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
      .toThrow("Project path is required")
  })
})
