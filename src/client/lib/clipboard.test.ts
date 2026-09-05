import { describe, expect, test } from "bun:test"
import { copyTextToClipboard } from "./clipboard"

function createFallbackDocument(options: { copyResult?: boolean; throwOnCopy?: boolean } = {}) {
  const state = {
    appended: false,
    copyCommand: "",
    created: false,
    focused: false,
    removed: false,
    selected: false,
    value: "",
  }
  const textarea = {
    value: "",
    style: {},
    setAttribute: () => {},
    focus: () => { state.focused = true },
    select: () => { state.selected = true },
    remove: () => { state.removed = true },
  } as unknown as HTMLTextAreaElement
  const documentRef = {
    activeElement: null,
    body: {
      append: (node: HTMLTextAreaElement) => {
        state.appended = node === textarea
        state.value = node.value
      },
    },
    createElement: (tagName: string) => {
      state.created = tagName === "textarea"
      return textarea
    },
    execCommand: (command: string) => {
      state.copyCommand = command
      if (options.throwOnCopy) throw new Error("copy blocked")
      return options.copyResult ?? true
    },
  } as unknown as Document

  return { documentRef, state }
}

describe("copyTextToClipboard", () => {
  test("uses the async Clipboard API when it succeeds", async () => {
    const writes: string[] = []
    const { documentRef, state } = createFallbackDocument()

    const copied = await copyTextToClipboard("upgrade safely", {
      clipboard: { writeText: async (text) => { writes.push(text) } },
      document: documentRef,
    })

    expect(copied).toBe(true)
    expect(writes).toEqual(["upgrade safely"])
    expect(state.created).toBe(false)
  })

  test("falls back to a temporary textarea when the Clipboard API is missing", async () => {
    const { documentRef, state } = createFallbackDocument()

    const copied = await copyTextToClipboard("fallback prompt", {
      clipboard: null,
      document: documentRef,
    })

    expect(copied).toBe(true)
    expect(state).toMatchObject({
      appended: true,
      copyCommand: "copy",
      created: true,
      focused: true,
      removed: true,
      selected: true,
      value: "fallback prompt",
    })
  })

  test("uses the fallback when the Clipboard API rejects the write", async () => {
    const { documentRef, state } = createFallbackDocument()

    const copied = await copyTextToClipboard("remote prompt", {
      clipboard: { writeText: async () => { throw new Error("not allowed") } },
      document: documentRef,
    })

    expect(copied).toBe(true)
    expect(state.copyCommand).toBe("copy")
    expect(state.removed).toBe(true)
  })

  test("reports failure and removes the temporary textarea when both paths fail", async () => {
    const { documentRef, state } = createFallbackDocument({ throwOnCopy: true })

    const copied = await copyTextToClipboard("blocked prompt", {
      clipboard: { writeText: async () => { throw new Error("not allowed") } },
      document: documentRef,
    })

    expect(copied).toBe(false)
    expect(state.removed).toBe(true)
  })
})
