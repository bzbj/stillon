import { describe, expect, test } from "bun:test"
import type { ToolResultBodyResult } from "../../shared/protocol"
import type { ToolResultEntry } from "../../shared/types"
import {
  type ToolResultLoadRequest,
  ToolResultSessionStore,
} from "./toolResultSessionStore"

function request(
  overrides: Partial<ToolResultLoadRequest> = {},
): ToolResultLoadRequest {
  return {
    chatId: "chat-1",
    resultId: "result-1",
    revision: "revision-1",
    byteLength: 64,
    ...overrides,
  }
}

function entry(
  requested: ToolResultLoadRequest,
  content: unknown,
): ToolResultEntry {
  return {
    _id: requested.resultId,
    kind: "tool_result",
    toolId: "tool-1",
    content,
    createdAt: 1,
  }
}

function ok(
  requested: ToolResultLoadRequest,
  content: unknown,
): ToolResultBodyResult {
  return {
    status: "ok",
    chatId: requested.chatId,
    resultId: requested.resultId,
    revision: requested.revision,
    entry: entry(requested, content),
  }
}

describe("ToolResultSessionStore", () => {
  test("deduplicates in-flight loads and reuses a session-cached result", async () => {
    const requested = request()
    let finish: (value: ToolResultBodyResult) => void = () => undefined
    let calls = 0
    const store = new ToolResultSessionStore(async () => {
      calls += 1
      return await new Promise<ToolResultBodyResult>((resolve) => {
        finish = resolve
      })
    })
    const release = store.retain(requested)

    const first = store.load(requested)
    const second = store.load(requested)
    expect(calls).toBe(1)
    expect(store.getSnapshot(requested).status).toBe("loading")

    finish(ok(requested, "complete"))
    expect(await first).toEqual(await second)
    expect(store.getSnapshot(requested)).toMatchObject({
      status: "ready",
      entry: { content: "complete" },
    })

    await store.load(requested)
    expect(calls).toBe(1)
    release()
  })

  test("isolates identical result IDs by chat and revision", async () => {
    const calls: ToolResultLoadRequest[] = []
    const store = new ToolResultSessionStore(async (requested) => {
      calls.push(requested)
      return ok(requested, `${requested.chatId}:${requested.revision}`)
    })
    const first = request()
    const otherChat = request({ chatId: "chat-2" })
    const otherRevision = request({ revision: "revision-2" })

    await Promise.all([
      store.load(first),
      store.load(otherChat),
      store.load(otherRevision),
    ])

    expect(calls).toHaveLength(3)
    expect(store.getSnapshot(first)).toMatchObject({
      status: "ready",
      entry: { content: "chat-1:revision-1" },
    })
    expect(store.getSnapshot(otherChat)).toMatchObject({
      status: "ready",
      entry: { content: "chat-2:revision-1" },
    })
    expect(store.getSnapshot(otherRevision)).toMatchObject({
      status: "ready",
      entry: { content: "chat-1:revision-2" },
    })
  })

  test("evicts least-recently-used unretained bodies by byte budget", async () => {
    const store = new ToolResultSessionStore(
      async (requested) => ok(requested, requested.resultId),
      { maxBytes: 12 },
    )
    const first = request({ resultId: "first", byteLength: 6 })
    const second = request({ resultId: "second", byteLength: 6 })
    const third = request({ resultId: "third", byteLength: 6 })

    await store.load(first)
    await store.load(second)
    store.retain(first)()
    await store.load(third)

    expect(store.getSnapshot(first).status).toBe("ready")
    expect(store.getSnapshot(second).status).toBe("preview")
    expect(store.getSnapshot(third).status).toBe("ready")
  })

  test("holds an over-budget result only while an expanded consumer retains it", async () => {
    const requested = request({ byteLength: 10 })
    const store = new ToolResultSessionStore(
      async () => ok(requested, "large"),
      { maxBytes: 5 },
    )
    const release = store.retain(requested)

    await store.load(requested)
    expect(store.getSnapshot(requested).status).toBe("ready")

    release()
    expect(store.getSnapshot(requested).status).toBe("preview")
  })

  test("keeps missing and stale responses distinct", async () => {
    const missingRequest = request({ resultId: "missing" })
    const staleRequest = request({ resultId: "stale" })
    const store = new ToolResultSessionStore(async (requested) => (
      requested.resultId === "missing"
        ? {
            status: "missing",
            chatId: requested.chatId,
            resultId: requested.resultId,
            revision: requested.revision,
          }
        : {
            status: "stale",
            chatId: requested.chatId,
            resultId: requested.resultId,
            requestedRevision: requested.revision,
            currentRevision: "revision-2",
          }
    ))

    await store.load(missingRequest)
    await store.load(staleRequest)

    expect(store.getSnapshot(missingRequest)).toEqual({ status: "missing" })
    expect(store.getSnapshot(staleRequest)).toEqual({
      status: "stale",
      currentRevision: "revision-2",
    })
  })

  test("rejects mismatched responses and permits an explicit retry", async () => {
    const requested = request()
    let calls = 0
    const store = new ToolResultSessionStore(async () => {
      calls += 1
      return calls === 1
        ? ok({ ...requested, resultId: "wrong" }, "wrong")
        : ok(requested, "right")
    })

    await store.load(requested)
    expect(store.getSnapshot(requested)).toEqual({
      status: "error",
      message: "Tool result response did not match the request.",
    })

    await store.load(requested, { force: true })
    expect(calls).toBe(2)
    expect(store.getSnapshot(requested)).toMatchObject({
      status: "ready",
      entry: { content: "right" },
    })
  })

  test("rejects a full result returned for another chat", async () => {
    const requested = request()
    const store = new ToolResultSessionStore(async () => ({
      ...ok(requested, "wrong chat"),
      chatId: "chat-2",
    }))

    await store.load(requested)

    expect(store.getSnapshot(requested)).toEqual({
      status: "error",
      message: "Tool result response did not match the request.",
    })
  })

  test("disposal clears retained bodies and ignores late responses", async () => {
    const requested = request()
    let finish: (value: ToolResultBodyResult) => void = () => undefined
    const store = new ToolResultSessionStore(async () => (
      await new Promise<ToolResultBodyResult>((resolve) => {
        finish = resolve
      })
    ))

    const pending = store.load(requested)
    store.dispose()
    finish(ok(requested, "late"))

    expect(await pending).toEqual({
      status: "error",
      message: "Tool result cache is disposed.",
    })
    expect(store.getSnapshot(requested).status).toBe("preview")
  })
})
