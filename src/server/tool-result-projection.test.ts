import { Buffer } from "node:buffer"
import { describe, expect, test } from "bun:test"
import type { ToolResultEntry, TranscriptEntry } from "../shared/types"
import {
  DEFAULT_TOOL_RESULT_INLINE_BYTES,
  DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
  getToolResultBodyByteLength,
  projectToolResultEntries,
  projectToolResultEntry,
  resolveToolResultProjectionOptions,
} from "./tool-result-projection"

function result(
  content: unknown,
  overrides: Partial<ToolResultEntry> = {},
): ToolResultEntry {
  return {
    _id: "result-1",
    kind: "tool_result",
    toolId: "tool-1",
    content,
    createdAt: 1,
    ...overrides,
  }
}

describe("tool result projection", () => {
  test("keeps bodies at or below the configured inline threshold untouched", () => {
    const entry = result("small")
    const bodyBytes = getToolResultBodyByteLength(entry)

    expect(projectToolResultEntry(entry, "revision-1", {
      inlineBytes: bodyBytes,
      previewBytes: 32,
    })).toBe(entry)
  })

  test("replaces an oversized text body with bounded metadata without mutating the source", () => {
    const entry = result("你好🙂".repeat(40), {
      debugRaw: JSON.stringify({ duplicated: "private body".repeat(20) }),
    })
    const original = structuredClone(entry)
    const projected = projectToolResultEntry(entry, "revision-1", {
      inlineBytes: 8,
      previewBytes: 19,
    })

    expect(entry).toEqual(original)
    expect(projected).not.toBe(entry)
    expect(projected.content).toBeNull()
    expect("debugRaw" in projected).toBe(false)
    expect(projected.deferredContent).toMatchObject({
      version: 1,
      resultId: "result-1",
      revision: "revision-1",
      byteLength: getToolResultBodyByteLength(entry),
      contentKind: "text",
      truncated: true,
    })
    expect(projected.deferredContent!.previewByteLength).toBeLessThanOrEqual(19)
    expect(Buffer.from(projected.deferredContent!.preview, "utf8").toString("utf8"))
      .toBe(projected.deferredContent!.preview)
  })

  test("keeps structured JSON previews readable and bounded", () => {
    const entry = result({
      records: Array.from({ length: 20 }, (_, index) => ({
        index,
        value: `value-${index}`,
      })),
    })
    const projected = projectToolResultEntry(entry, "revision-json", {
      inlineBytes: 1,
      previewBytes: 80,
    })

    expect(projected.deferredContent?.contentKind).toBe("json")
    expect(projected.deferredContent?.previewByteLength).toBeLessThanOrEqual(80)
    expect(projected.deferredContent?.preview).toStartWith("{")
  })

  test("summarizes binary blocks without leaking base64 into the preview", () => {
    const base64 = Buffer.alloc(12_000, 7).toString("base64")
    const entry = result({
      content: [
        { type: "text", text: "image result" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: base64,
          },
        },
      ],
    })
    const projected = projectToolResultEntry(entry, "revision-binary", {
      inlineBytes: 64,
      previewBytes: 512,
    })

    expect(projected.deferredContent?.contentKind).toBe("binary")
    expect(projected.deferredContent?.binaryItems).toEqual([{
      kind: "image",
      mimeType: "image/png",
      byteLength: 12_000,
    }])
    expect(projected.deferredContent?.preview).toContain("image/png")
    expect(projected.deferredContent?.preview).not.toContain(base64.slice(0, 100))
    expect(JSON.stringify(projected)).not.toContain(base64.slice(0, 100))
  })

  test("bounds traversal of wide and deeply nested preview values", () => {
    const base64 = Buffer.alloc(8_000, 9).toString("base64")
    let nested: unknown = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: base64,
      },
    }
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { nested }
    }
    const projected = projectToolResultEntry(result({
      rows: Array.from({ length: 2_000 }, (_, index) => `row-${index}`),
      nested,
    }), "revision-bounded-traversal", {
      inlineBytes: 64,
      previewBytes: 64 * 1024,
    })

    expect(projected.deferredContent?.preview).toContain("[additional content omitted]")
    expect(projected.deferredContent?.preview).not.toContain(base64.slice(0, 100))
    expect(JSON.stringify(projected)).not.toContain(base64.slice(0, 100))
  })

  test("defers a small content value when debugRaw is the oversized body", () => {
    const debugRaw = JSON.stringify({
      tool_use_result: {
        answers: { environment: "production" },
        padding: "x".repeat(10_000),
      },
    })
    const projected = projectToolResultEntry(result("ok", { debugRaw }), "revision-debug", {
      inlineBytes: 128,
      previewBytes: 128,
    })

    expect(projected.content).toBeNull()
    expect("debugRaw" in projected).toBe(false)
    expect(projected.deferredContent?.byteLength).toBeGreaterThan(10_000)
  })

  test("projects only changed tool-result entries and preserves other references", () => {
    const prompt: TranscriptEntry = {
      _id: "prompt-1",
      kind: "user_prompt",
      content: "hello",
      createdAt: 1,
    }
    const small = result("small", { _id: "small" })
    const large = result("x".repeat(1_000), { _id: "large" })
    const entries = [prompt, small, large]
    const projected = projectToolResultEntries(entries, "revision-list", {
      inlineBytes: 128,
      previewBytes: 32,
    })

    expect(projected).not.toBe(entries)
    expect(projected[0]).toBe(prompt)
    expect(projected[1]).toBe(small)
    expect(projected[2]).not.toBe(large)
  })

  test("keeps interactive prompt results inline even when their debug payload is large", () => {
    const toolCall: TranscriptEntry = {
      _id: "call-1",
      kind: "tool_call",
      createdAt: 1,
      tool: {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName: "AskUserQuestion",
        toolId: "interactive-tool",
        input: {
          questions: [{ question: "Continue?" }],
        },
      },
    }
    const interactiveResult = result({ answers: { "Continue?": ["Yes"] } }, {
      toolId: "interactive-tool",
      debugRaw: "x".repeat(10_000),
    })

    const projected = projectToolResultEntries(
      [toolCall, interactiveResult],
      "revision-interactive",
      { inlineBytes: 32, previewBytes: 16 },
    )

    expect(projected).toBeArrayOfSize(2)
    expect(projected[1]).toBe(interactiveResult)
    expect((projected[1] as ToolResultEntry).deferredContent).toBeUndefined()
  })

  test("reads bounded byte settings and falls back for invalid values", () => {
    expect(resolveToolResultProjectionOptions({
      STILLON_TOOL_RESULT_INLINE_BYTES: "4096",
      STILLON_TOOL_RESULT_PREVIEW_BYTES: "512",
    })).toEqual({
      inlineBytes: 4096,
      previewBytes: 512,
    })
    expect(resolveToolResultProjectionOptions({
      STILLON_TOOL_RESULT_INLINE_BYTES: "-1",
      STILLON_TOOL_RESULT_PREVIEW_BYTES: "not-a-number",
    })).toEqual({
      inlineBytes: DEFAULT_TOOL_RESULT_INLINE_BYTES,
      previewBytes: DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
    })
  })
})
