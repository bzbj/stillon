import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedToolCall } from "../../../shared/types"
import { ToolResultSessionStore } from "../../lib/toolResultSessionStore"
import { ReadResultImages, ToolCallMessage } from "./ToolCallMessage"
import { ToolResultHydrationProvider } from "./tool-result-hydration"

describe("ToolCallMessage", () => {
  test("renders read result image blocks as inline images", () => {
    const html = renderToStaticMarkup(
      <ReadResultImages
        images={[
          {
            type: "image",
            data: "ZmFrZS1pbWFnZS1kYXRh",
            mimeType: "image/png",
          },
        ]}
      />
    )

    expect(html).toContain("data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh")
    expect(html).toContain("alt=\"Read result 1\"")
  })

  test("renders bounded deferred metadata without loading a collapsed result", () => {
    let loads = 0
    const store = new ToolResultSessionStore(async (request) => {
      loads += 1
      return {
        status: "missing",
        chatId: request.chatId,
        resultId: request.resultId,
        revision: request.revision,
      }
    })
    const message = {
      id: "call-1",
      kind: "tool",
      toolKind: "bash",
      toolName: "Bash",
      toolId: "tool-1",
      input: { command: "generate-report" },
      deferredResult: {
        version: 1,
        resultId: "result-1",
        revision: "revision-1",
        byteLength: 1024 * 1024,
        contentKind: "text",
        preview: "bounded preview only",
        previewByteLength: 20,
        truncated: true,
      },
      timestamp: new Date(0).toISOString(),
    } satisfies HydratedToolCall

    const html = renderToStaticMarkup(
      <ToolResultHydrationProvider
        chatId="chat-1"
        store={store}
        refreshTranscript={() => undefined}
      >
        <ToolCallMessage message={message} />
      </ToolResultHydrationProvider>
    )

    expect(loads).toBe(0)
    expect(html).toContain("text · 1.0 MiB")
    expect(html).toContain("bounded preview only")
    expect(html).not.toContain("Loading full result")
  })
})
