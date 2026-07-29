import { describe, expect, test } from "bun:test"
import { processTranscriptMessages } from "./parseTranscript"
import { getLatestToolIds } from "../app/derived"
import { hasToolResult } from "../../shared/tools"
import type { TranscriptEntry } from "../../shared/types"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...partial,
  } as TranscriptEntry
}

describe("processTranscriptMessages", () => {
  test("hydrates tool results onto prior tool calls", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: "/Users/example/Projects/stillon\n",
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBe("/Users/example/Projects/stillon\n")
  })

  test("preserves deferred result metadata without treating the preview as a full result", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-deferred",
          input: { command: "large-command" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-deferred",
        content: null,
        deferredContent: {
          version: 1,
          resultId: "result-deferred",
          revision: "revision-1",
          byteLength: 1_000_000,
          contentKind: "text",
          preview: "bounded preview",
          previewByteLength: 15,
          truncated: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBeUndefined()
    expect(messages[0].rawResult).toBeUndefined()
    expect(messages[0].deferredResult).toMatchObject({
      resultId: "result-deferred",
      revision: "revision-1",
      preview: "bounded preview",
    })
    expect(hasToolResult(messages[0])).toBe(true)
  })

  test("keeps last-result-wins semantics across inline and deferred entries", () => {
    const call = entry({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "bash",
        toolName: "Bash",
        toolId: "tool-replaced",
        input: { command: "pwd" },
      },
    })
    const deferred = entry({
      kind: "tool_result",
      toolId: "tool-replaced",
      content: null,
      deferredContent: {
        version: 1,
        resultId: "result-deferred",
        revision: "revision-1",
        byteLength: 100_000,
        contentKind: "text",
        preview: "preview",
        previewByteLength: 7,
        truncated: true,
      },
    })
    const inline = entry({
      kind: "tool_result",
      toolId: "tool-replaced",
      content: false,
    })

    const deferredLast = processTranscriptMessages([call, inline, deferred])[0]
    expect(deferredLast?.kind).toBe("tool")
    if (deferredLast?.kind !== "tool") throw new Error("unexpected message")
    expect(deferredLast.result).toBeUndefined()
    expect(deferredLast.deferredResult?.resultId).toBe("result-deferred")

    const inlineLast = processTranscriptMessages([call, deferred, inline])[0]
    expect(inlineLast?.kind).toBe("tool")
    if (inlineLast?.kind !== "tool") throw new Error("unexpected message")
    expect(inlineLast.deferredResult).toBeUndefined()
    expect(inlineLast.result).toBe(false)
    expect(hasToolResult(inlineLast)).toBe(true)
  })

  test("hydrates ask-user-question results with typed answers", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-2",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("hydrates discarded prompt tool results", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-3",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { discarded: true },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ discarded: true })
  })

  test("preserves attachments on hydrated user prompts", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "user_prompt",
        content: "Please inspect these.",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
          relativePath: "./.kanna/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
      }),
    ])

    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].attachments).toHaveLength(1)
    expect(messages[0].attachments?.[0]?.relativePath).toBe("./.kanna/uploads/spec.pdf")
  })

  test("preserves context window update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "context_window_updated",
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          compactsAutomatically: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("context_window_updated")
    if (messages[0]?.kind !== "context_window_updated") throw new Error("unexpected message")
    expect(messages[0].usage.maxTokens).toBe(258_400)
    expect(messages[0].usage.compactsAutomatically).toBe(true)
  })

  test("preserves structured Claude ask-user-question results when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-3",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: "User has answered your questions: \"Provider?\"=\"Codex\".",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: {
            questions: [{ question: "Provider?" }],
            answers: { "Provider?": "Codex" },
          },
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })
})

describe("getLatestToolIds", () => {
  test("returns the latest unresolved special tool ids", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "tool-2",
          input: {
            todos: [{ content: "Implement adapter", status: "in_progress", activeForm: "Implementing adapter" }],
          },
        },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: messages[0]?.kind === "tool" ? messages[0].id : null,
      ExitPlanMode: null,
      TodoWrite: messages[1]?.kind === "tool" ? messages[1].id : null,
    })
  })

  test("ignores discarded special tools when choosing the latest active id", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: { discarded: true, answers: {} },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-2",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { discarded: true },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: null,
      ExitPlanMode: null,
      TodoWrite: null,
    })
  })
})
