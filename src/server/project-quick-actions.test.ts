import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { normalizeQuickActions, readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"

describe("project quick actions", () => {
  test("normalizes persisted quick actions", () => {
    expect(normalizeQuickActions({
      quickActions: [
        { id: "dev", label: "Dev", command: "bun run dev" },
        { id: "dev", label: "Duplicate", command: "echo duplicate" },
        { id: "empty", label: "Empty", command: " " },
        { id: "test", command: "bun test" },
      ],
    })).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
      { id: "test", label: "bun test", command: "bun test" },
    ])
  })

  test("writes quick actions to the project .kanna directory", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "kanna-project-quick-actions-"))

    const written = await writeProjectQuickActions(projectPath, [
      { id: "dev", label: "Dev", command: "bun run dev" },
    ])

    expect(written).toEqual([
      { id: "dev", label: "Dev", command: "bun run dev" },
    ])
    await expect(readProjectQuickActions(projectPath)).resolves.toEqual(written)
    await expect(Bun.file(path.join(projectPath, ".kanna", "quick-actions.json")).exists()).resolves.toBe(true)
  })
})
