import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AsyncQuestionMessage } from "./AsyncQuestionMessage"
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
