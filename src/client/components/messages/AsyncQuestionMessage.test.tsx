import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AsyncQuestionMessage, asyncQuestionAnswerValue, isAsyncQuestionComplete } from "./AsyncQuestionMessage"
import type { HydratedTranscriptMessage } from "../../../shared/types"

function message(): Extract<HydratedTranscriptMessage, { kind: "assistant_text" }> {
  return {
    id: "message-1",
    messageId: undefined,
    timestamp: new Date(0).toISOString(),
    hidden: undefined,
    kind: "assistant_text",
    text: "Which output format?",
    asyncQuestion: {
      threadId: "thread-1",
      originTurnId: "turn-1",
      providerItemId: "item-1",
      questions: [
        { index: 0, title: "Which output format?", options: ["Markdown", "HTML"] },
        { index: 1, title: "Any constraints?", options: null },
      ],
    },
  }
}

const noopSubmit = () => Promise.reject(new Error("not used"))

describe("AsyncQuestionMessage", () => {
  test("shows options and a free-text field with nothing preselected or sent", () => {
    const html = renderToStaticMarkup(
      <AsyncQuestionMessage message={message()} onSubmit={noopSubmit as never} />,
    )

    expect(html).toContain("Which output format?")
    expect(html).toContain("Markdown")
    expect(html).toContain("HTML")
    expect(html).toContain("Any constraints?")
    expect(html).toContain("发送")
    // No default choice: every radio is unchecked.
    expect(html).not.toContain("checked=\"\"")
  })

  test("does not offer a send action in read-only exports", () => {
    const html = renderToStaticMarkup(
      <AsyncQuestionMessage message={message()} readOnly onSubmit={noopSubmit as never} />,
    )

    expect(html).toContain("只读导出")
    expect(html).not.toContain(">发送<")
  })

  test("renders the sent answers and status once accepted", () => {
    const html = renderToStaticMarkup(
      <AsyncQuestionMessage
        message={message()}
        response={{
          schemaVersion: 1,
          chatId: "chat-1",
          questionKey: "[]",
          submissionId: "submission-1",
          answers: [{ index: 0, value: "HTML" }, { index: 1, value: "none" }],
          status: "accepted",
          error: null,
          localMessageId: "queued-1",
          providerTurnId: "turn-1",
          createdAt: 1,
          updatedAt: 2,
        }}
        onSubmit={noopSubmit as never}
      />,
    )

    expect(html).toContain("已发送")
    expect(html).toContain("答案：HTML")
    expect(html).toContain("答案：none")
    expect(html).not.toContain(">发送<")
  })
})

describe("async question draft completeness", () => {
  const optionQuestion = { index: 0, options: ["Markdown", "HTML"] }
  const freeTextQuestion = { index: 1, options: null }
  const empty = { selections: {}, customMode: {}, customValues: {} }

  test("a free-text question is answered from the typed value without custom mode", () => {
    const draft = { selections: {}, customMode: {}, customValues: { 1: "keep it short" } }
    expect(asyncQuestionAnswerValue(freeTextQuestion, draft)).toBe("keep it short")
    expect(isAsyncQuestionComplete([freeTextQuestion], draft)).toBe(true)
  })

  test("an option question needs a selection or an explicit custom answer", () => {
    expect(isAsyncQuestionComplete([optionQuestion], empty)).toBe(false)
    expect(isAsyncQuestionComplete([optionQuestion], { selections: { 0: "HTML" }, customMode: {}, customValues: {} })).toBe(true)
    expect(isAsyncQuestionComplete([optionQuestion], {
      selections: { 0: "HTML" },
      customMode: { 0: true },
      customValues: {},
    })).toBe(false)
    expect(isAsyncQuestionComplete([optionQuestion], {
      selections: {},
      customMode: { 0: true },
      customValues: { 0: "plain" },
    })).toBe(true)
  })

  test("both questions must be answered", () => {
    expect(isAsyncQuestionComplete([optionQuestion, freeTextQuestion], {
      selections: { 0: "HTML" },
      customMode: {},
      customValues: {},
    })).toBe(false)
    expect(isAsyncQuestionComplete([optionQuestion, freeTextQuestion], {
      selections: { 0: "HTML" },
      customMode: {},
      customValues: { 1: "none" },
    })).toBe(true)
  })
})
