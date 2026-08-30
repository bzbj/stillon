import { describe, expect, test } from "bun:test"
import { getClaudeCliCommand, resolveClaudeCodeExecutable } from "./claude-executable"

describe("Claude executable resolution", () => {
  test("trims and expands a configured home-relative executable", () => {
    expect(resolveClaudeCodeExecutable({
      environment: { CLAUDE_EXECUTABLE: "  ~/bin/claude  " },
      homeDirectory: "/srv/stillon",
    })).toBe("/srv/stillon/bin/claude")

    expect(resolveClaudeCodeExecutable({
      environment: { CLAUDE_EXECUTABLE: "~\\bin\\claude.cmd" },
      homeDirectory: "C:\\Users\\stillon",
    })).toBe("C:\\Users\\stillon\\bin\\claude.cmd")
  })

  test("preserves absolute paths and ignores empty overrides", () => {
    expect(resolveClaudeCodeExecutable({
      environment: { CLAUDE_EXECUTABLE: "/opt/claude/bin/claude" },
    })).toBe("/opt/claude/bin/claude")
    expect(resolveClaudeCodeExecutable({
      environment: { CLAUDE_EXECUTABLE: "   " },
    })).toBeUndefined()
  })

  test("uses the configured executable before platform defaults", () => {
    expect(getClaudeCliCommand({
      environment: { CLAUDE_EXECUTABLE: "/opt/claude/bin/claude" },
      platform: "win32",
    })).toBe("/opt/claude/bin/claude")
    expect(getClaudeCliCommand({ environment: {}, platform: "win32" })).toBe("claude.cmd")
    expect(getClaudeCliCommand({ environment: {}, platform: "darwin" })).toBe("claude")
    expect(getClaudeCliCommand({ environment: {}, platform: "linux" })).toBe("claude")
  })
})
