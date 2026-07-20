import { describe, expect, test } from "bun:test"
import { appendLocalPathSegment, getLocalPathPrefix } from "./localPaths"

describe("local path display helpers", () => {
  test("formats macOS and Linux paths with forward slashes", () => {
    const location = { path: "/Users/alice/StillOn", separator: "/" as const }

    expect(getLocalPathPrefix(location)).toBe("/Users/alice/StillOn/")
    expect(appendLocalPathSegment(location, "my-project")).toBe("/Users/alice/StillOn/my-project")
  })

  test("formats Windows paths with backslashes", () => {
    const location = { path: "C:\\Users\\Alice\\StillOn", separator: "\\" as const }

    expect(getLocalPathPrefix(location)).toBe("C:\\Users\\Alice\\StillOn\\")
    expect(appendLocalPathSegment(location, "my-project")).toBe("C:\\Users\\Alice\\StillOn\\my-project")
  })

  test("does not duplicate the separator for filesystem roots", () => {
    expect(getLocalPathPrefix({ path: "/", separator: "/" })).toBe("/")
    expect(getLocalPathPrefix({ path: "C:\\", separator: "\\" })).toBe("C:\\")
  })
})
