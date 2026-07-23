import { describe, expect, test } from "bun:test"
import {
  applySidebarProjectOrder,
  countMatchingUserPrompts,
  getActiveChatSnapshot,
  getNextMeasuredInputHeight,
  getNewestRemainingChatId,
  getPreviousPrompt,
  getTranscriptPaddingBottom,
  getUserPromptSignature,
  isHistoryCursorExpiredError,
  reconcileHistoryPaginationSnapshot,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  shouldMarkActiveChatRead,
  shouldAutoFollowTranscript,
} from "./useKannaState"
import type { ChatAttachment, ChatSnapshot, SidebarData, TranscriptEntry, UserPromptEntry } from "../../shared/types"

function createSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-1",
        title: "Project 1",
        realTitle: "Project 1",
        localPath: "/tmp/project-1",
        chats: [
          {
            _id: "row-1",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Newest",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 3,
            hasAutomation: false,
          },
          {
            _id: "row-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Older",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 2,
            hasAutomation: false,
          },
          {
            _id: "row-3",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Oldest",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: false,
      },
      {
        groupKey: "project-2",
        title: "Project 2",
        realTitle: "Project 2",
        localPath: "/tmp/project-2",
        chats: [
          {
            _id: "row-4",
            _creationTime: 1,
            chatId: "chat-4",
            title: "Other project",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-2",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: true,
      },
    ],
  }
}

describe("getNewestRemainingChatId", () => {
  test("returns the next newest chat from the same project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-3")).toBe("chat-2")
  })

  test("returns null when no other chats remain in the project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBeNull()
  })

  test("returns null when the chat is not found", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "missing")).toBeNull()
  })
})

describe("applySidebarProjectOrder", () => {
  test("reorders project groups immediately using the optimistic order", () => {
    const sidebarData = createSidebarData()

    expect(
      applySidebarProjectOrder(sidebarData.projectGroups, ["project-2", "project-1"]).map((group) => group.groupKey)
    ).toEqual(["project-2", "project-1"])
  })

  test("keeps unspecified groups at the end and ignores unknown ids", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["missing", "project-2"])

    expect(reordered.map((group) => group.groupKey)).toEqual(["project-2", "project-1"])
  })

  test("returns the original array when the order already matches", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["project-1", "project-2"])

    expect(reordered).toBe(sidebarData.projectGroups)
  })
})

describe("shouldAutoFollowTranscript", () => {
  test("returns true when the transcript is at the bottom", () => {
    expect(shouldAutoFollowTranscript(0)).toBe(true)
  })

  test("returns true when the transcript is near the bottom", () => {
    expect(shouldAutoFollowTranscript(23)).toBe(true)
  })

  test("returns false when the transcript is not near the bottom", () => {
    expect(shouldAutoFollowTranscript(24)).toBe(false)
  })
})

describe("getTranscriptPaddingBottom", () => {
  test("keeps the extra bottom offset even when the input height is zero", () => {
    expect(getTranscriptPaddingBottom(0)).toBe(30)
  })

  test("adds the fixed offset to the measured input height", () => {
    expect(getTranscriptPaddingBottom(140)).toBe(170)
  })

  test("scales linearly as the composer grows", () => {
    expect(getTranscriptPaddingBottom(200) - getTranscriptPaddingBottom(140)).toBe(60)
  })
})

describe("getNextMeasuredInputHeight", () => {
  test("keeps the previous height when a transient zero measurement is reported", () => {
    expect(getNextMeasuredInputHeight(148, 0)).toBe(148)
  })

  test("accepts the latest non-zero measurement", () => {
    expect(getNextMeasuredInputHeight(148, 178)).toBe(178)
  })
})

describe("shouldMarkActiveChatRead", () => {
  test("returns true only when the page is visible and focused", () => {
    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(true)

    expect(shouldMarkActiveChatRead({
      visibilityState: "hidden",
      hasFocus: () => true,
    })).toBe(false)

    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(false)
  })
})

describe("resolveComposeIntent", () => {
  test("prefers the selected project when available", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: "project-selected",
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-selected" })
  })

  test("falls back to the first sidebar project", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-sidebar" })
  })

  test("uses the first local project path when no project is selected", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "local_path", localPath: "/tmp/project" })
  })

  test("returns null when no project target exists", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: null,
      })
    ).toBeNull()
  })
})

describe("getActiveChatSnapshot", () => {
  test("returns the snapshot when it matches the active chat id", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "idle",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      history: {
        hasOlder: false,
        olderCursor: null,
        recentLimit: 200,
        revision: "revision-1",
      },
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-1")).toEqual(snapshot)
  })

  test("returns null for a stale snapshot from a previous route", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-old",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Old chat",
        status: "idle",
        isDraining: false,
        provider: "claude",
        planMode: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      history: {
        hasOlder: false,
        olderCursor: null,
        recentLimit: 200,
        revision: "revision-old",
      },
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-new")).toBeNull()
  })
})

describe("reconcileHistoryPaginationSnapshot", () => {
  function transcriptEntry(index: number): TranscriptEntry {
    return {
      _id: `message-${index}`,
      kind: "assistant_text",
      createdAt: index,
      text: `message ${index}`,
    }
  }

  function snapshot(
    revision: string,
    messages: TranscriptEntry[],
    olderCursor: string | null,
    hasOlder: boolean,
  ): ChatSnapshot {
    return {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "running",
        isDraining: false,
        provider: "codex",
        planMode: false,
        sessionToken: "session-1",
      },
      queuedMessages: [],
      messages,
      history: {
        hasOlder,
        olderCursor,
        recentLimit: 3,
        revision,
      },
      availableProviders: [],
    }
  }

  test("preserves fallen-out tail entries and the earliest loaded cursor during live updates", () => {
    const initial = reconcileHistoryPaginationSnapshot(
      null,
      snapshot("revision-1", [transcriptEntry(3), transcriptEntry(4), transcriptEntry(5)], "cursor-3", true),
    )
    const updated = reconcileHistoryPaginationSnapshot(
      initial.state,
      snapshot("revision-1", [transcriptEntry(4), transcriptEntry(5), transcriptEntry(6)], "cursor-4", true),
    )

    expect(updated.reset).toBe(false)
    expect(updated.fallenOutEntries.map((entry) => entry._id)).toEqual(["message-3"])
    expect(updated.state.olderCursor).toBe("cursor-3")
    expect(updated.state.recentEntries.map((entry) => entry._id)).toEqual(["message-4", "message-5", "message-6"])
  })

  test("resets loaded pagination when the transcript revision changes", () => {
    const initial = reconcileHistoryPaginationSnapshot(
      null,
      snapshot("revision-1", [transcriptEntry(1)], null, false),
    )
    const replaced = reconcileHistoryPaginationSnapshot(
      initial.state,
      snapshot("revision-2", [transcriptEntry(9)], "cursor-9", true),
    )

    expect(replaced.reset).toBe(true)
    expect(replaced.fallenOutEntries).toEqual([])
    expect(replaced.state.revision).toBe("revision-2")
    expect(replaced.state.olderCursor).toBe("cursor-9")
  })

  test("resets to the latest contiguous page when live windows no longer overlap", () => {
    const initial = reconcileHistoryPaginationSnapshot(
      null,
      snapshot("revision-1", [transcriptEntry(1), transcriptEntry(2)], null, false),
    )
    const jumped = reconcileHistoryPaginationSnapshot(
      initial.state,
      snapshot("revision-1", [transcriptEntry(500), transcriptEntry(501)], "cursor-500", true),
    )

    expect(jumped.reset).toBe(true)
    expect(jumped.fallenOutEntries).toEqual([])
    expect(jumped.state.olderCursor).toBe("cursor-500")
    expect(jumped.state.hasOlder).toBe(true)
  })

  test("adopts the server cursor when an empty live window first receives history", () => {
    const initial = reconcileHistoryPaginationSnapshot(
      null,
      snapshot("revision-1", [], null, false),
    )
    const populated = reconcileHistoryPaginationSnapshot(
      initial.state,
      snapshot("revision-1", [transcriptEntry(200), transcriptEntry(201)], "cursor-200", true),
    )

    expect(populated.reset).toBe(true)
    expect(populated.state.olderCursor).toBe("cursor-200")
    expect(populated.state.hasOlder).toBe(true)
  })
})

describe("isHistoryCursorExpiredError", () => {
  test("recognizes only the structured history refresh error", () => {
    expect(isHistoryCursorExpiredError(new Error("History cursor expired. Refresh the chat and try again."))).toBe(true)
    expect(isHistoryCursorExpiredError(new Error("Transcript contains an invalid record."))).toBe(false)
    expect(isHistoryCursorExpiredError("History cursor expired.")).toBe(false)
  })
})

describe("getPreviousPrompt", () => {
  test("returns the latest non-empty user prompt", () => {
    expect(getPreviousPrompt([
      {
        kind: "assistant_text",
        text: "hello",
        id: "assistant-1",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        kind: "user_prompt",
        content: "first prompt",
        id: "user-1",
        timestamp: "2024-01-01T00:00:01.000Z",
      },
      {
        kind: "user_prompt",
        content: "   ",
        id: "user-2",
        timestamp: "2024-01-01T00:00:02.000Z",
      },
      {
        kind: "user_prompt",
        content: "second prompt",
        id: "user-3",
        timestamp: "2024-01-01T00:00:03.000Z",
      },
    ])).toBe("second prompt")
  })
})

describe("optimistic user prompts", () => {
  function createUserPrompt(
    id: string,
    content: string,
    attachments: ChatAttachment[] = [],
  ): UserPromptEntry {
    return {
      _id: id,
      createdAt: 1,
      kind: "user_prompt",
      content,
      attachments,
    }
  }

  test("counts matching prompts by content and attachments", () => {
    const attachment: ChatAttachment = {
      id: "att-1",
      kind: "file",
      displayName: "spec.txt",
      absolutePath: "/tmp/spec.txt",
      relativePath: "spec.txt",
      contentUrl: "/uploads/spec.txt",
      mimeType: "text/plain",
      size: 12,
    }
    const signature = getUserPromptSignature("Review this", [attachment])

    expect(countMatchingUserPrompts([
      createUserPrompt("msg-1", "Review this", [attachment]),
      createUserPrompt("msg-2", "Review this"),
    ], signature)).toBe(1)
  })

  test("reconciles duplicate optimistic prompts in order", () => {
    const optimisticPrompts = [
      {
        id: "opt-1",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 1,
        entry: createUserPrompt("optimistic:1", "same"),
      },
      {
        id: "opt-2",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 2,
        entry: createUserPrompt("optimistic:2", "same"),
      },
    ]

    expect(reconcileOptimisticUserPrompts(
      optimisticPrompts,
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompts[1]])
  })

  test("does not reconcile prompts from other chat scopes", () => {
    const optimisticPrompt = {
      id: "opt-1",
      scopeId: "chat-2",
      signature: getUserPromptSignature("same"),
      requiredMatchCount: 1,
      entry: createUserPrompt("optimistic:1", "same"),
    }

    expect(reconcileOptimisticUserPrompts(
      [optimisticPrompt],
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompt])
  })
})
