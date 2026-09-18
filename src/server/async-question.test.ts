import { describe, expect, test } from "bun:test"
import {
  asyncQuestionContextFromItem,
  buildAsyncQuestionAnswerText,
  normalizeAsyncQuestions,
  validateAsyncQuestionAnswers,
} from "./async-question"
import { asyncQuestionKey } from "../shared/types"

describe("normalizeAsyncQuestions", () => {
  test("keeps options and assigns the array index as identity", () => {
    expect(normalizeAsyncQuestions([
      { title: "Which output format?", options: ["Markdown", "HTML"] },
    ])).toEqual([
      { index: 0, title: "Which output format?", options: ["Markdown", "HTML"] },
    ])
  })

  test("supports null and omitted options as free text", () => {
    expect(normalizeAsyncQuestions([{ title: "Any constraints?", options: null }])).toEqual([
      { index: 0, title: "Any constraints?", options: null },
    ])
    expect(normalizeAsyncQuestions([{ title: "Any constraints?" }])).toEqual([
      { index: 0, title: "Any constraints?", options: null },
    ])
  })

  test("distinguishes questions with identical titles by position", () => {
    const questions = normalizeAsyncQuestions([
      { title: "Choose a format", options: ["Markdown", "HTML"] },
      { title: "Choose a format", options: ["Plain text", "JSON"] },
    ])
    expect(questions?.map((question) => question.index)).toEqual([0, 1])
    expect(questions?.[1]?.options).toEqual(["Plain text", "JSON"])
  })

  test("rejects empty, malformed, and oversized question lists", () => {
    expect(normalizeAsyncQuestions([])).toBeNull()
    expect(normalizeAsyncQuestions(undefined)).toBeNull()
    expect(normalizeAsyncQuestions([{ title: 123, options: "invalid" }])).toBeNull()
    expect(normalizeAsyncQuestions([{ title: "   " }])).toBeNull()
    expect(normalizeAsyncQuestions([{ title: "ok", options: [1, 2] }])).toBeNull()
    expect(normalizeAsyncQuestions(new Array(21).fill({ title: "q" }))).toBeNull()
  })
})

describe("asyncQuestionContextFromItem", () => {
  const item = {
    id: "item-1",
    type: "agent_message",
    text: "Which output format?",
    delivery: "async",
    questions: [{ title: "Which output format?", options: ["Markdown", "HTML"] }],
  }

  test("builds metadata for an async item with valid questions", () => {
    expect(asyncQuestionContextFromItem(item, "thread-1", "turn-1")).toEqual({
      threadId: "thread-1",
      originTurnId: "turn-1",
      providerItemId: "item-1",
      questions: [{ index: 0, title: "Which output format?", options: ["Markdown", "HTML"] }],
    })
  })

  test("returns null for ordinary text, missing questions, or unknown delivery", () => {
    expect(asyncQuestionContextFromItem({ ...item, delivery: null }, "thread-1", "turn-1")).toBeNull()
    expect(asyncQuestionContextFromItem({ ...item, questions: [] }, "thread-1", "turn-1")).toBeNull()
    expect(asyncQuestionContextFromItem({ ...item, delivery: "sync" }, "thread-1", "turn-1")).toBeNull()
    expect(asyncQuestionContextFromItem({ ...item, id: "" }, "thread-1", "turn-1")).toBeNull()
    expect(asyncQuestionContextFromItem(item, "", "turn-1")).toBeNull()
  })
})

describe("validateAsyncQuestionAnswers", () => {
  const questions = normalizeAsyncQuestions([
    { title: "Format", options: ["Markdown", "HTML"] },
    { title: "Constraints", options: null },
  ])!

  test("accepts one answer per question including custom values", () => {
    const result = validateAsyncQuestionAnswers(questions, [
      { index: 0, value: "HTML" },
      { index: 1, value: "keep it short" },
    ])
    expect(result.ok).toBe(true)
    expect(result.answers).toEqual([
      { index: 0, value: "HTML" },
      { index: 1, value: "keep it short" },
    ])
  })

  test("rejects missing, duplicate, unknown, empty, and oversized answers", () => {
    expect(validateAsyncQuestionAnswers(questions, [{ index: 0, value: "HTML" }]).ok).toBe(false)
    expect(validateAsyncQuestionAnswers(questions, [
      { index: 0, value: "HTML" },
      { index: 0, value: "Markdown" },
    ]).ok).toBe(false)
    expect(validateAsyncQuestionAnswers(questions, [
      { index: 0, value: "HTML" },
      { index: 5, value: "x" },
    ]).ok).toBe(false)
    expect(validateAsyncQuestionAnswers(questions, [
      { index: 0, value: "  " },
      { index: 1, value: "x" },
    ]).ok).toBe(false)
    expect(validateAsyncQuestionAnswers(questions, [
      { index: 0, value: "x".repeat(9_000) },
      { index: 1, value: "y" },
    ]).ok).toBe(false)
  })
})

describe("buildAsyncQuestionAnswerText", () => {
  test("restates every question with its answer", () => {
    const questions = normalizeAsyncQuestions([
      { title: "Which output format?", options: ["Markdown", "HTML"] },
      { title: "Any constraints?" },
    ])!
    expect(buildAsyncQuestionAnswerText(questions, [
      { index: 0, value: "HTML" },
      { index: 1, value: "none" },
    ])).toBe("回答问题：Which output format?\n答案：HTML\n\n回答问题：Any constraints?\n答案：none")
  })
})

describe("asyncQuestionKey", () => {
  test("is structured and collision-safe for ids containing separators", () => {
    const left = asyncQuestionKey({ threadId: "a|b", originTurnId: "c", providerItemId: "d" })
    const right = asyncQuestionKey({ threadId: "a", originTurnId: "b|c", providerItemId: "d" })
    expect(left).not.toBe(right)
    expect(asyncQuestionKey({ threadId: "t", originTurnId: "u", providerItemId: "i" }))
      .toBe(asyncQuestionKey({ threadId: "t", originTurnId: "u", providerItemId: "i" }))
  })
})
