import { expect, test } from "bun:test"
import { createEmptyState } from "./events"
import { workspaceCommandAllowed, workspaceHttpAllowed, workspaceState, workspaceTopicAllowed } from "./workspace-access"

test("invited workspace capabilities follow actual resource ownership and never caller-supplied grouping", () => {
  const state = createEmptyState()
  for (const id of ["shared", "private"]) {
    state.projectsById.set(id, { id, title: id, localPath: `/example/${id}`, createdAt: 1, updatedAt: 1 })
    state.chatsById.set(`${id}-chat`, { id: `${id}-chat`, projectId: id, title: id, createdAt: 1, updatedAt: 1, unread: false, provider: null, planMode: false, sessionToken: null, lastTurnOutcome: null })
  }
  const terminals = { getSnapshot: (id: string) => ({ cwd: `/example/${id}` }) } as never
  expect([...workspaceState(state, "shared").projectsById.keys()]).toEqual(["shared"])
  expect([...workspaceState(state, "shared").chatsById.keys()]).toEqual(["shared-chat"])
  expect(workspaceTopicAllowed({ type: "chat", chatId: "private-chat" }, "shared", state, terminals)).toBe(false)
  expect(workspaceTopicAllowed({ type: "terminal", terminalId: "private" }, "shared", state, terminals)).toBe(false)
  for (const command of [
    null, { type: 1 }, { type: "settings.writeAppSettingsPatch", patch: null },
    { type: "project.create", localPath: "/example/new", title: "New" },
    { type: "project.open", localPath: "/example/private" },
    { type: "chat.send", chatId: "private-chat", projectId: "shared", content: "Example" },
    { type: "chat.create", projectId: "private" },
    { type: "chat.setDraftProtection", chatIds: ["shared-chat", "private-chat"] },
    { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { private: true } } },
    { type: "settings.writeAppSettingsPatch", patch: { machineName: "Changed" } },
  ]) expect(workspaceCommandAllowed(command as never, "shared", state, terminals)).toBe(false)
  for (const command of [
    { type: "chat.create", projectId: "shared" }, { type: "chat.archive", chatId: "shared-chat" },
    { type: "chat.cancel", chatId: "shared-chat", runId: "observed-run" },
    { type: "settings.writeAppSettingsPatch", patch: { workspaceCollapsed: { shared: true }, workspaceCollapseExpectedVersions: { shared: 0 } } },
  ]) expect(workspaceCommandAllowed(command as never, "shared", state, terminals)).toBe(true)
  expect(workspaceHttpAllowed(new URL("http://localhost/api/projects/private/preview/report.html"), "GET", "shared")).toBe(false)
  expect(workspaceHttpAllowed(new URL("http://localhost/api/projects/%70rivate/files/x/content"), "GET", "shared")).toBe(false)
  expect(workspaceHttpAllowed(new URL("http://localhost/api/projects/shared/uploads"), "POST", "shared")).toBe(true)
  expect(workspaceHttpAllowed(new URL("http://localhost/api/appearance/avatars"), "POST", "shared")).toBe(false)
  expect(workspaceHttpAllowed(new URL("http://localhost/api/provider-setup/claude"), "POST", "shared")).toBe(false)
})
