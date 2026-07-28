import { describe, expect, test } from "bun:test"
import type { ChatDeltaEvent } from "../../shared/protocol"
import type { ChatRuntime, ChatSnapshot, TranscriptEntry } from "../../shared/types"
import {
  applyChatStreamDelta,
  applyChatStreamSnapshot,
  createChatStreamState,
} from "./chatStreamState"

function entry(id: string, text = id): TranscriptEntry {
  return {
    _id: id,
    kind: "assistant_text",
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    text,
  }
}

function runtime(chatId = "chat-1", status: ChatRuntime["status"] = "idle"): ChatRuntime {
  return {
    chatId,
    projectId: "project-1",
    localPath: "/tmp/example-project",
    title: "Example chat",
    status,
    isDraining: false,
    provider: "codex",
    planMode: false,
    sessionToken: "session-1",
  }
}

function historySnapshot(
  revision = "history-1",
  options: { hasOlder?: boolean; olderCursor?: string | null } = {},
): ChatSnapshot["history"] {
  return {
    hasOlder: options.hasOlder ?? false,
    olderCursor: options.olderCursor ?? null,
    recentLimit: 200,
    revision,
  }
}

function snapshot(options: {
  chatId?: string
  messages?: TranscriptEntry[]
  revision?: string
  sequence?: number
  includeStream?: boolean
} = {}): ChatSnapshot {
  const chatId = options.chatId ?? "chat-1"
  return {
    runtime: runtime(chatId),
    queuedMessages: [],
    messages: options.messages ?? [entry("message-1"), entry("message-2")],
    history: historySnapshot(),
    availableProviders: [],
    stream: options.includeStream === false
      ? undefined
      : {
          version: 1,
          revision: options.revision ?? "stream-1",
          sequence: options.sequence ?? 0,
        },
  }
}

function delta(options: {
  chatId?: string
  revision?: string
  baseSequence?: number
  sequence?: number
  transcript?: ChatDeltaEvent["transcript"]
  runtime?: ChatRuntime
  queuedMessages?: ChatDeltaEvent["queuedMessages"]
  history?: ChatDeltaEvent["history"]
  availableProviders?: ChatDeltaEvent["availableProviders"]
} = {}): ChatDeltaEvent {
  return {
    type: "chat.delta",
    chatId: options.chatId ?? "chat-1",
    baseSequence: options.baseSequence ?? 0,
    stream: {
      version: 1,
      revision: options.revision ?? "stream-1",
      sequence: options.sequence ?? 1,
    },
    transcript: options.transcript,
    runtime: options.runtime,
    queuedMessages: options.queuedMessages,
    history: options.history,
    availableProviders: options.availableProviders,
  }
}

function withBaseline(value = snapshot()) {
  const initial = createChatStreamState("chat-1")
  const transition = applyChatStreamSnapshot(initial, value)
  if (transition.kind !== "baseline") throw new Error("expected baseline")
  return transition.state
}

describe("chat stream full baselines", () => {
  test("accepts an authoritative baseline and clears pending resync state", () => {
    const initial = {
      ...createChatStreamState("chat-1"),
      resyncPending: true,
    }
    const value = snapshot()

    const transition = applyChatStreamSnapshot(initial, value)

    expect(transition.kind).toBe("baseline")
    expect(transition.state.snapshot).toBe(value)
    expect(transition.state.resyncPending).toBe(false)
    expect(transition.transcriptChange).toBe("reset")
  })

  test("accepts a replacement baseline even when entry ids and order are unchanged", () => {
    const first = snapshot({
      messages: [entry("message-1", "old content")],
      sequence: 2,
    })
    const current = withBaseline(first)
    const replacement = snapshot({
      messages: [entry("message-1", "new content")],
      revision: "stream-2",
      sequence: 0,
    })

    const transition = applyChatStreamSnapshot(current, replacement)

    expect(transition.kind).toBe("baseline")
    expect(transition.state.snapshot).toBe(replacement)
    expect(transition.state.snapshot?.messages[0]).toEqual(entry("message-1", "new content"))
  })

  test("accepts an old-server snapshot without stream metadata", () => {
    const value = snapshot({ includeStream: false })
    const transition = applyChatStreamSnapshot(createChatStreamState("chat-1"), value)

    expect(transition.kind).toBe("baseline")
    expect(transition.state.snapshot).toBe(value)
    expect(transition.state.resyncPending).toBe(false)
  })

  test("accepts duplicate ids only for a full-snapshot fallback", () => {
    const duplicateEntries = [entry("message-1"), entry("message-1")]
    const fallback = snapshot({
      messages: duplicateEntries,
      includeStream: false,
    })

    const transition = applyChatStreamSnapshot(
      createChatStreamState("chat-1"),
      fallback,
    )

    expect(transition.kind).toBe("baseline")
    expect(transition.state.snapshot).toBe(fallback)
    expect(transition.state.resyncPending).toBe(false)
    expect(transition.transcriptReset).toBe(true)
  })

  test("forces pagination reset when a duplicate-id fallback becomes streamable", () => {
    const fallback = snapshot({
      messages: [entry("message-1"), entry("message-1"), entry("message-2")],
      includeStream: false,
    })
    const current = withBaseline(fallback)
    const recovered = snapshot({
      messages: [entry("message-1"), entry("message-2"), entry("message-3")],
      revision: "stream-2",
    })

    const transition = applyChatStreamSnapshot(current, recovered)

    expect(transition.kind).toBe("baseline")
    expect(transition.transcriptReset).toBe(true)
    expect(transition.state.snapshot).toBe(recovered)
  })

  test("rejects a wrong-chat or internally duplicate baseline", () => {
    const initial = createChatStreamState("chat-1")
    const wrongChat = applyChatStreamSnapshot(initial, snapshot({ chatId: "chat-2" }))
    const duplicateEntries = applyChatStreamSnapshot(initial, snapshot({
      messages: [entry("message-1"), entry("message-1")],
    }))

    expect(wrongChat.kind).toBe("resync_required")
    if (wrongChat.kind === "resync_required") {
      expect(wrongChat.reason).toBe("wrong_chat")
    }
    expect(wrongChat.state.resyncPending).toBe(true)

    expect(duplicateEntries.kind).toBe("resync_required")
    if (duplicateEntries.kind === "resync_required") {
      expect(duplicateEntries.reason).toBe("invalid_baseline")
    }
    expect(duplicateEntries.state.snapshot).toBeNull()
  })

  test("rejects malformed baseline stream metadata without throwing", () => {
    const malformed = {
      ...snapshot(),
      stream: null,
    } as unknown as ChatSnapshot

    const transition = applyChatStreamSnapshot(
      createChatStreamState("chat-1"),
      malformed,
    )

    expect(transition.kind).toBe("resync_required")
    if (transition.kind === "resync_required") {
      expect(transition.reason).toBe("invalid_baseline")
    }
    expect(transition.state.resyncPending).toBe(true)
  })

  test("uses a null snapshot as an authoritative empty baseline", () => {
    const current = withBaseline()
    const transition = applyChatStreamSnapshot(current, null)

    expect(transition.kind).toBe("baseline")
    expect(transition.state.snapshot).toBeNull()
    expect(transition.state.resyncPending).toBe(false)
  })
})

describe("chat stream deltas", () => {
  test("applies eviction, removal, replacement, and append atomically in server order", () => {
    const first = entry("message-1")
    const second = entry("message-2", "old")
    const third = entry("message-3")
    const current = withBaseline(snapshot({ messages: [first, second, third] }))
    const secondReplacement = entry("message-2", "new")
    const appended = entry("message-4")

    const transition = applyChatStreamDelta(current, delta({
      transcript: {
        type: "patch",
        evictedIds: ["message-1"],
        removedIds: ["message-3"],
        replaced: [secondReplacement],
        appended: [appended],
      },
    }))

    expect(transition.kind).toBe("applied")
    expect(transition.transcriptChange).toBe("patch")
    expect(transition.evictedEntries).toEqual([first])
    expect(transition.removedIds).toEqual(["message-3"])
    expect(transition.state.snapshot?.messages).toEqual([
      secondReplacement,
      appended,
    ])
    expect(transition.state.snapshot?.messages[0]).toBe(secondReplacement)
    expect(transition.state.snapshot?.stream?.sequence).toBe(1)
    expect(current.snapshot?.messages).toEqual([first, second, third])
  })

  test("relays an idempotent structural removal outside the recent window", () => {
    const current = withBaseline()
    const transition = applyChatStreamDelta(current, delta({
      transcript: {
        type: "patch",
        evictedIds: [],
        removedIds: ["older-message"],
        replaced: [],
        appended: [],
      },
    }))

    expect(transition.kind).toBe("applied")
    expect(transition.transcriptChange).toBe("patch")
    expect(transition.evictedEntries).toEqual([])
    expect(transition.removedIds).toEqual(["older-message"])
    expect(transition.state.snapshot?.messages).toEqual(current.snapshot?.messages)
  })

  test("applies a reset as authoritative server ordering", () => {
    const current = withBaseline()
    const resetMessages = [entry("message-9"), entry("message-7")]
    const resetHistory = historySnapshot("history-reset", {
      hasOlder: true,
      olderCursor: "cursor-reset",
    })

    const transition = applyChatStreamDelta(current, delta({
      history: historySnapshot("ignored-top-level-history"),
      transcript: {
        type: "reset",
        messages: resetMessages,
        history: resetHistory,
      },
    }))

    expect(transition.kind).toBe("applied")
    expect(transition.transcriptChange).toBe("reset")
    expect(transition.transcriptReset).toBe(true)
    expect(transition.state.snapshot?.messages).toBe(resetMessages)
    expect(transition.state.snapshot?.history).toBe(resetHistory)
    expect(transition.evictedEntries).toEqual([])
    expect(transition.removedIds).toEqual([])
  })

  test("preserves the message array for metadata-only deltas", () => {
    const current = withBaseline()
    const messages = current.snapshot?.messages
    const nextRuntime = runtime("chat-1", "running")

    const transition = applyChatStreamDelta(current, delta({
      runtime: nextRuntime,
      queuedMessages: [{
        id: "queued-1",
        content: "Follow up",
        attachments: [],
        createdAt: 10,
      }],
    }))

    expect(transition.kind).toBe("applied")
    expect(transition.transcriptChange).toBe("none")
    expect(transition.transcriptReset).toBe(false)
    expect(transition.state.snapshot?.messages).toBe(messages)
    expect(transition.state.snapshot?.runtime).toBe(nextRuntime)
    expect(transition.state.snapshot?.queuedMessages[0]?.id).toBe("queued-1")
  })

  test("treats a same-content replacement as a semantic no-op", () => {
    const original: TranscriptEntry = {
      _id: "message-1",
      kind: "user_prompt",
      createdAt: 1,
      content: "Inspect this",
      attachments: [{
        id: "attachment-1",
        kind: "file",
        displayName: "example.txt",
        absolutePath: "/tmp/example-project/example.txt",
        relativePath: "example.txt",
        contentUrl: "/api/example.txt",
        mimeType: "text/plain",
        size: 12,
      }],
    }
    const replacement: TranscriptEntry = {
      ...original,
      attachments: original.kind === "user_prompt"
        ? original.attachments?.map((attachment) => ({ ...attachment }))
        : [],
    }
    const current = withBaseline(snapshot({ messages: [original] }))
    const messages = current.snapshot?.messages

    const transition = applyChatStreamDelta(current, delta({
      transcript: {
        type: "patch",
        evictedIds: [],
        removedIds: [],
        replaced: [replacement],
        appended: [],
      },
    }))

    expect(transition.kind).toBe("applied")
    expect(transition.transcriptChange).toBe("none")
    expect(transition.state.snapshot?.messages).toBe(messages)
    expect(transition.state.snapshot?.messages[0]).toBe(original)
    expect(transition.state.snapshot?.stream?.sequence).toBe(1)
  })

  test("classifies the exact last frame as a reference-preserving duplicate", () => {
    const current = withBaseline()
    const event = delta({ runtime: runtime("chat-1", "running") })
    const applied = applyChatStreamDelta(current, event)
    if (applied.kind !== "applied") throw new Error("expected applied delta")

    const duplicate = applyChatStreamDelta(applied.state, event)

    expect(duplicate.kind).toBe("duplicate")
    expect(duplicate.state).toBe(applied.state)
    expect(duplicate.state.resyncPending).toBe(false)
  })

  test("requires a baseline with stream metadata before applying a delta", () => {
    const missingBaseline = applyChatStreamDelta(
      createChatStreamState("chat-1"),
      delta(),
    )
    const oldServerBaseline = applyChatStreamDelta(
      withBaseline(snapshot({ includeStream: false })),
      delta(),
    )

    expect(missingBaseline.kind).toBe("resync_required")
    if (missingBaseline.kind === "resync_required") {
      expect(missingBaseline.reason).toBe("missing_baseline")
    }
    expect(oldServerBaseline.kind).toBe("resync_required")
    if (oldServerBaseline.kind === "resync_required") {
      expect(oldServerBaseline.reason).toBe("missing_stream")
    }
  })

  test.each([
    {
      name: "wrong chat",
      event: delta({ chatId: "chat-2" }),
      reason: "wrong_chat",
    },
    {
      name: "wrong stream revision",
      event: delta({ revision: "stream-2" }),
      reason: "revision_mismatch",
    },
    {
      name: "sequence gap",
      event: delta({ baseSequence: 0, sequence: 2 }),
      reason: "sequence_gap",
    },
  ] as const)("marks resync synchronously for $name", ({ event, reason }) => {
    const current = withBaseline()
    const transition = applyChatStreamDelta(current, event)

    expect(transition.kind).toBe("resync_required")
    if (transition.kind === "resync_required") {
      expect(transition.reason).toBe(reason)
    }
    expect(transition.state.resyncPending).toBe(true)
    expect(transition.state.snapshot).toBe(current.snapshot)
  })

  test("marks an older frame as out of order", () => {
    const current = withBaseline(snapshot({ sequence: 2 }))
    const transition = applyChatStreamDelta(current, delta({
      baseSequence: 0,
      sequence: 1,
    }))

    expect(transition.kind).toBe("resync_required")
    if (transition.kind === "resync_required") {
      expect(transition.reason).toBe("out_of_order")
    }
    expect(transition.state.resyncPending).toBe(true)
  })

  test.each([
    {
      name: "null event",
      value: null,
    },
    {
      name: "missing stream",
      value: {
        ...delta(),
        stream: null,
      },
    },
    {
      name: "non-string revision",
      value: {
        ...delta(),
        stream: {
          version: 1,
          revision: 42,
          sequence: 1,
        },
      },
    },
    {
      name: "non-array patch field",
      value: {
        ...delta(),
        transcript: {
          type: "patch",
          evictedIds: [],
          removedIds: [],
          replaced: {},
          appended: [],
        },
      },
    },
    {
      name: "reset without history",
      value: {
        ...delta(),
        transcript: {
          type: "reset",
          messages: [],
        },
      },
    },
    {
      name: "non-array metadata",
      value: {
        ...delta(),
        queuedMessages: {},
      },
    },
  ])("marks malformed parsed payload as one resync: $name", ({ value }) => {
    const current = withBaseline()

    const transition = applyChatStreamDelta(
      current,
      value as unknown as ChatDeltaEvent,
    )

    expect(transition.kind).toBe("resync_required")
    if (transition.kind === "resync_required") {
      expect(transition.reason).toBe("impossible_operation")
    }
    expect(transition.state.resyncPending).toBe(true)
    expect(transition.state.snapshot).toBe(current.snapshot)
  })

  test.each([
    {
      name: "evict an unknown id",
      transcript: {
        type: "patch",
        evictedIds: ["missing"],
        removedIds: [],
        replaced: [],
        appended: [],
      },
    },
    {
      name: "replace an unknown id",
      transcript: {
        type: "patch",
        evictedIds: [],
        removedIds: [],
        replaced: [entry("missing")],
        appended: [],
      },
    },
    {
      name: "append an existing id",
      transcript: {
        type: "patch",
        evictedIds: [],
        removedIds: [],
        replaced: [],
        appended: [entry("message-1", "conflict")],
      },
    },
    {
      name: "target one id with two operations",
      transcript: {
        type: "patch",
        evictedIds: ["message-1"],
        removedIds: [],
        replaced: [entry("message-1", "conflict")],
        appended: [],
      },
    },
    {
      name: "reset with duplicate ids",
      transcript: {
        type: "reset",
        messages: [entry("message-8"), entry("message-8")],
        history: historySnapshot("history-reset"),
      },
    },
  ] satisfies Array<{ name: string; transcript: ChatDeltaEvent["transcript"] }>)(
    "rejects impossible operation: $name",
    ({ transcript }) => {
      const current = withBaseline()
      const messages = current.snapshot?.messages
      const transition = applyChatStreamDelta(current, delta({
        transcript,
        runtime: runtime("chat-1", "running"),
      }))

      expect(transition.kind).toBe("resync_required")
      if (transition.kind === "resync_required") {
        expect(transition.reason).toBe("impossible_operation")
      }
      expect(transition.state.resyncPending).toBe(true)
      expect(transition.state.snapshot).toBe(current.snapshot)
      expect(transition.state.snapshot?.messages).toBe(messages)
      expect(transition.state.snapshot?.runtime.status).toBe("idle")
    },
  )

  test("ignores subsequent deltas until a full baseline recovers the stream", () => {
    const current = withBaseline()
    const gap = applyChatStreamDelta(current, delta({ sequence: 3 }))
    const whilePending = applyChatStreamDelta(gap.state, delta())

    expect(whilePending.kind).toBe("resync_required")
    if (whilePending.kind === "resync_required") {
      expect(whilePending.reason).toBe("resync_pending")
    }
    expect(whilePending.state).toBe(gap.state)

    const recovered = applyChatStreamSnapshot(
      whilePending.state,
      snapshot({ revision: "stream-2", sequence: 10 }),
    )
    const next = applyChatStreamDelta(recovered.state, delta({
      revision: "stream-2",
      baseSequence: 10,
      sequence: 11,
      runtime: runtime("chat-1", "running"),
    }))

    expect(recovered.kind).toBe("baseline")
    expect(recovered.state.resyncPending).toBe(false)
    expect(next.kind).toBe("applied")
    expect(next.state.snapshot?.stream?.sequence).toBe(11)
  })

  test("does not request another resync for an invalid recovery baseline", () => {
    const current = withBaseline()
    const pending = applyChatStreamDelta(current, delta({ sequence: 3 }))
    const invalidRecovery = applyChatStreamSnapshot(
      pending.state,
      snapshot({ chatId: "chat-2" }),
    )

    expect(invalidRecovery.kind).toBe("resync_required")
    if (invalidRecovery.kind === "resync_required") {
      expect(invalidRecovery.reason).toBe("resync_pending")
    }
    expect(invalidRecovery.state).toBe(pending.state)
  })
})
