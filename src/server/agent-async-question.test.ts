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

  test("keeps a still-running steer failure as failed instead of resending", async () => {
    const harness = await createHarness({
      supportsNativeSteer: true,
      steerTurn: async (args: any) => {
        harness.steerCalls.push(args)
        throw new Error("transport reset")
      },
    })
    harness.setActiveTurnId("turn-1")

    const result = await harness.coordinator.answerAsyncQuestion(answerCommand(harness.chatId))

    expect(result.status).toBe("failed")
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

  test("recovers a crash-left submitting record as safely retryable", async () => {
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
    expect(result.status).toBe("failed")
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
})
