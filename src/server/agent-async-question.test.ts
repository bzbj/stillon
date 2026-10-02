import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { asyncQuestionKey, type AsyncQuestionContext, type TranscriptEntry } from "../shared/types"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const QUESTION: AsyncQuestionContext = {
  threadId: "thread-1",
  originTurnId: "turn-1",
  providerItemId: "item-1",
  questions: [{ index: 0, title: "Which output format?", options: ["Markdown", "HTML"] }],
}
const KEY = asyncQuestionKey(QUESTION)

async function createHarness(managerOverrides: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "stillon-async-answer-"))
  tempDirs.push(dataDir)
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject("/tmp/project")
  const chat = await store.createChat(project.id)
  await store.setChatProvider(chat.id, "codex")
  await store.setSessionToken(chat.id, "thread-1")
  const questionEntry: TranscriptEntry = {
    _id: "question-entry",
    createdAt: Date.now(),
    kind: "assistant_text",
    text: "Which output format?",
    asyncQuestion: QUESTION,
  }
  await store.appendMessage(chat.id, questionEntry)

  const steerCalls: any[] = []
  let activeTurnId: string | null = null
  const manager = {
    supportsNativeSteer: false,
    getActiveTurnId: () => activeTurnId,
    steerTurn: async (args: any) => {
      steerCalls.push(args)
      return { turnId: "turn-1" }
    },
    startSession: async () => "thread-1",
    startTurn: async () => {
      throw new Error("turn start is not expected in this test")
    },
    generateStructured: async () => null,
    stopSession: () => {},
    stopAll: () => {},
    ...managerOverrides,
  }
  const coordinator = new AgentCoordinator({
    store,
    onStateChange: () => {},
    codexManager: manager as never,
  })
  // Keep the queue from draining so the durable follow-up stays inspectable.
  ;(coordinator as any).scheduleQueuedMessages = () => {}

  return {
    store,
    chatId: chat.id,
    coordinator,
    steerCalls,
    setActiveTurnId: (value: string | null) => {
      activeTurnId = value
    },
  }
}

function answerCommand(chatId: string, submissionId = "submission-1") {
  return {
    type: "chat.answerAsyncQuestion" as const,
    chatId,
    questionKey: KEY,
    submissionId,
    answers: [{ index: 0, value: "HTML" }],
  }
}

describe("AgentCoordinator.answerAsyncQuestion", () => {
  test("idle chat queues one same-thread follow-up that restates the question", async () => {
    const { store, chatId, coordinator, steerCalls } = await createHarness()

    const result = await coordinator.answerAsyncQuestion(answerCommand(chatId))

    expect(result.status).toBe("queued")
    expect(result.duplicate).toBeFalsy()
    expect(steerCalls).toHaveLength(0)
    const queued = store.getQueuedMessages(chatId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.asyncQuestionSubmissionId).toBe("submission-1")
    expect(queued[0]!.asyncQuestionKey).toBe(KEY)
    expect(queued[0]!.content).toBe("回答问题：Which output format?\n答案：HTML")
    expect(store.getAsyncQuestionResponse(chatId, KEY)?.status).toBe("queued")
    expect(store.getAsyncQuestionResponse(chatId, KEY)?.localMessageId).toBe(result.localMessageId)
  })

  test("a repeated submissionId returns the recorded result without a second send", async () => {
    const { store, chatId, coordinator } = await createHarness()

    const first = await coordinator.answerAsyncQuestion(answerCommand(chatId))
    const second = await coordinator.answerAsyncQuestion(answerCommand(chatId))

    expect(second.duplicate).toBe(true)
    expect(second.status).toBe(first.status)
    expect(store.getQueuedMessages(chatId)).toHaveLength(1)
  })

  test("a second client answering the same question gets the existing answer", async () => {
    const { store, chatId, coordinator } = await createHarness()
    await coordinator.answerAsyncQuestion(answerCommand(chatId, "submission-1"))

    const other = await coordinator.answerAsyncQuestion(answerCommand(chatId, "submission-2"))

    expect(other.duplicate).toBe(true)
    expect(other.submissionId).toBe("submission-1")
    expect(store.getQueuedMessages(chatId)).toHaveLength(1)
  })

  test("rejects a question that belongs to another chat", async () => {
    const { store, coordinator } = await createHarness()
    const otherProject = await store.openProject("/tmp/other")
    const otherChat = await store.createChat(otherProject.id)

    await expect(coordinator.answerAsyncQuestion(answerCommand(otherChat.id))).rejects.toThrow("不属于此会话")
  })

  test("rejects invalid answers before any provider call", async () => {
    const { store, chatId, coordinator, steerCalls } = await createHarness()

    await expect(coordinator.answerAsyncQuestion({
      ...answerCommand(chatId),
      answers: [{ index: 0, value: "   " }],
    })).rejects.toThrow("答案")

    expect(steerCalls).toHaveLength(0)
    expect(store.getQueuedMessages(chatId)).toEqual([])
  })

  test("uses native turn/steer while the origin turn is running", async () => {
    const harness = await createHarness({ supportsNativeSteer: true })
    harness.setActiveTurnId("turn-1")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId, "submission-steer"))

    expect(result.status).toBe("accepted")
    expect(result.providerTurnId).toBe("turn-1")
    expect(harness.steerCalls).toEqual([{
      chatId: harness.chatId,
      expectedTurnId: "turn-1",
      content: "回答问题：Which output format?\n答案：HTML",
      clientUserMessageId: "submission-steer",
    }])
    expect(harness.store.getQueuedMessages(harness.chatId)).toEqual([])
    expect(harness.store.getAsyncQuestionResponse(harness.chatId, KEY)?.status).toBe("accepted")
  })

  test("falls back to one follow-up when steer is rejected because the turn ended", async () => {
    const harness = await createHarness({
      supportsNativeSteer: true,
      steerTurn: async (args: any) => {
        harness.steerCalls.push(args)
        harness.setActiveTurnId(null)
        throw new Error("turn/steer failed: expectedTurnId does not match the active turn")
      },
    })
    harness.setActiveTurnId("turn-1")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))

    expect(harness.steerCalls).toHaveLength(1)
    expect(result.status).toBe("queued")
    expect(harness.store.getQueuedMessages(harness.chatId)).toHaveLength(1)
  })

  test("keeps a still-running transport failure unknown instead of enabling resending", async () => {
    const harness = await createHarness({
      supportsNativeSteer: true,
      steerTurn: async (args: any) => {
        harness.steerCalls.push(args)
        throw new Error("transport reset")
      },
    })
    harness.setActiveTurnId("turn-1")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))

    expect(result.status).toBe("delivery_unknown")
    expect(harness.store.getQueuedMessages(harness.chatId)).toEqual([])
  })

  test("queues a follow-up when a different turn owns the chat", async () => {
    const harness = await createHarness({ supportsNativeSteer: true })
    harness.setActiveTurnId("turn-other")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))

    expect(result.status).toBe("queued")
    expect(harness.steerCalls).toHaveLength(0)
    expect(harness.store.getQueuedMessages(harness.chatId)).toHaveLength(1)
  })

  test("leaves an unconfirmable provider send as delivery_unknown", async () => {
    const harness = await createHarness({
      supportsNativeSteer: true,
      steerTurn: async (args: any) => {
        harness.steerCalls.push(args)
        harness.setActiveTurnId(null)
        throw new Error("socket hang up while awaiting turn/steer")
      },
    })
    harness.setActiveTurnId("turn-1")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))

    expect(result.status).toBe("delivery_unknown")
    expect(harness.store.getQueuedMessages(harness.chatId)).toEqual([])
    expect(harness.store.getAsyncQuestionResponse(harness.chatId, KEY)?.status).toBe("delivery_unknown")
  })

  test("keeps a crash-left submission unknown without proof of non-delivery", async () => {
    const { store, chatId, coordinator } = await createHarness()
    await store.recordAsyncQuestionResponse({
      schemaVersion: 1,
      chatId,
      questionKey: KEY,
      submissionId: "submission-crashed",
      answers: [{ index: 0, value: "HTML" }],
      status: "submitting",
      error: null,
      localMessageId: null,
      providerTurnId: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await coordinator.answerAsyncQuestion(answerCommand(chatId, "submission-crashed"))

    expect(result.duplicate).toBe(true)
    expect(result.status).toBe("delivery_unknown")
    expect(store.getQueuedMessages(chatId)).toEqual([])
  })

  test("recovers a crash-left submitting record as queued when the follow-up exists", async () => {
    const { store, chatId, coordinator } = await createHarness()
    const queued = await store.enqueueMessage(chatId, {
      content: "回答问题：Which output format?\n答案：HTML",
      attachments: [],
      asyncQuestionSubmissionId: "submission-crashed",
      asyncQuestionKey: KEY,
    })
    await store.recordAsyncQuestionResponse({
      schemaVersion: 1,
      chatId,
      questionKey: KEY,
      submissionId: "submission-crashed",
      answers: [{ index: 0, value: "HTML" }],
      status: "submitting",
      error: null,
      localMessageId: null,
      providerTurnId: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await coordinator.answerAsyncQuestion(answerCommand(chatId, "submission-crashed"))

    expect(result.duplicate).toBe(true)
    expect(result.status).toBe("queued")
    expect(result.localMessageId).toBe(queued.id)
  })
  test("status query sees a live submission without reconciling or sending twice", async () => {
    let resolveSteer!: (value: { turnId: string }) => void
    const harness = await createHarness({ supportsNativeSteer: true, steerTurn: (args: any) => {
      harness.steerCalls.push(args)
      return new Promise((resolve) => { resolveSteer = resolve })
    } })
    harness.setActiveTurnId("turn-1")
    const sending = harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))
    while (!resolveSteer) await Bun.sleep(1)
    const queried = await harness.coordinator.getAsyncQuestionResponse(harness.chatId, KEY)
    expect(queried?.status).toBe("submitting")
    expect(harness.steerCalls).toHaveLength(1)
    resolveSteer({ turnId: "turn-1" })
    await sending
    expect((await harness.coordinator.getAsyncQuestionResponse(harness.chatId, KEY))?.status).toBe("accepted")
    expect(await harness.coordinator.getAsyncQuestionResponse(harness.chatId, "other-key")).toBeNull()
  })
  test("confirmed failed submission can retry edited answers with a new ID", async () => {
    let reject = true
    const harness = await createHarness({ supportsNativeSteer: true, steerTurn: async (args: any) => {
      harness.steerCalls.push(args)
      if (reject) throw new Error("expectedTurnId mismatch")
      return { turnId: "turn-1" }
    } })
    harness.setActiveTurnId("turn-1")
    const failed = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId, "first"))
    expect(failed.status).toBe("failed")
    reject = false
    const result = await harness.coordinator.answerAsyncQuestion({ ...answerCommand(harness.chatId, "second"), answers: [{ index: 0, value: "Markdown" }] })
    expect(result.status).toBe("accepted")
    expect(result.submissionId).toBe("second")
    expect(result.answers[0]?.value).toBe("Markdown")
    expect(harness.steerCalls).toHaveLength(2)
  })
  test("status query does not turn an incomplete record into a failed delivery", async () => {
    const { store, chatId, coordinator, steerCalls } = await createHarness()
    await store.recordAsyncQuestionResponse({ schemaVersion: 1, chatId, questionKey: KEY, submissionId: "crash", answers: [{ index: 0, value: "HTML" }], status: "submitting", error: null, localMessageId: null, providerTurnId: null, createdAt: 1, updatedAt: 1 })
    expect((await coordinator.getAsyncQuestionResponse(chatId, KEY))?.status).toBe("submitting")
    expect(steerCalls).toHaveLength(0)
    expect(store.getQueuedMessages(chatId)).toHaveLength(0)
  })

  test("opt-in server state diagnostics contain IDs/timing but no question or answer", async () => {
    const previous = process.env.STILLON_DEBUG_ASYNC_ANSWERS
    const original = console.debug
    const logs: unknown[][] = []
    try {
      process.env.STILLON_DEBUG_ASYNC_ANSWERS = "1"
      console.debug = (...args) => { logs.push(args) }
      const { chatId, coordinator } = await createHarness()
      await coordinator.answerAsyncQuestion({ ...answerCommand(chatId), answers: [{ index: 0, value: "PRIVATE_SENTINEL" }] })
      const serialized = JSON.stringify(logs)
      expect(serialized).toContain("submission-1")
      expect(serialized).toContain("server_state")
      expect(serialized).not.toContain("PRIVATE_SENTINEL")
      expect(serialized).not.toContain("Which output format?")
      expect(logs).toHaveLength(2)
    } finally {
      console.debug = original
      if (previous === undefined) delete process.env.STILLON_DEBUG_ASYNC_ANSWERS
      else process.env.STILLON_DEBUG_ASYNC_ANSWERS = previous
    }
  })

})
