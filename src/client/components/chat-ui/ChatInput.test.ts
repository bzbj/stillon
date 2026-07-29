import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../shared/types"
import {
  ChatInput,
  createPendingComposerAttachment,
  getClipboardImageFiles,
  getUploadNetworkError,
  getUploadResponseError,
  isDesktopLikeInputDevice,
  trimTrailingPastedNewlines,
  uploadProjectAttachment,
  willExceedAttachmentLimit,
} from "./ChatInput"

function createClipboardItem(args: {
  kind?: string
  type: string
  file?: File | null
}) {
  return {
    kind: args.kind ?? "file",
    type: args.type,
    getAsFile: () => args.file ?? null,
  }
}

describe("willExceedAttachmentLimit", () => {
  test("rejects a batch that would push the composer above the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 3,
    })).toBe(true)
  })

  test("allows a batch that exactly reaches the total attachment limit", () => {
    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 45,
      queuedAttachmentCount: 3,
      incomingAttachmentCount: 2,
    })).toBe(false)
  })

  test("counts pasted files against the same total attachment limit", () => {
    const pastedFiles = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/png", file: new File(["b"], "", { type: "image/png" }) }),
    ], 123)

    expect(willExceedAttachmentLimit({
      currentAttachmentCount: 48,
      queuedAttachmentCount: 0,
      incomingAttachmentCount: pastedFiles.length,
    })).toBe(false)
  })
})

describe("upload errors", () => {
  test("identifies an Access redirect before following it", async () => {
    const response = new Response(null, { status: 302 })
    Object.defineProperty(response, "type", { value: "opaqueredirect" })

    await expect(getUploadResponseError(response)).resolves.toBe(
      "Cloudflare Access redirected this upload to sign-in. Reload this page and sign in again."
    )
  })

  test("includes Cloudflare diagnostics for a blocked HTML response", async () => {
    const response = new Response("<html>blocked</html>", {
      status: 403,
      headers: {
        "content-type": "text/html",
        "cf-ray": "abc123-SIN",
      },
    })

    await expect(getUploadResponseError(response)).resolves.toBe(
      "Cloudflare or browser access controls blocked this upload (HTTP 403). Cloudflare Ray ID: abc123-SIN."
    )
  })

  test("keeps server-provided upload errors", async () => {
    const response = Response.json({ error: "File exceeds the 100 MB limit." }, { status: 413 })

    await expect(getUploadResponseError(response)).resolves.toBe("File exceeds the 100 MB limit.")
  })

  test("turns browser network failures into an actionable message", () => {
    expect(getUploadNetworkError(new TypeError("Failed to fetch"))).toContain("could not reach the upload endpoint")
  })
})

describe("attachment uploads without crypto.randomUUID", () => {
  test("creates the pending attachment and sends the upload request", async () => {
    const randomUuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID")
    const xhrDescriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest")

    class FakeXMLHttpRequest {
      static latest: FakeXMLHttpRequest | null = null

      method = ""
      url = ""
      body: XMLHttpRequestBodyInit | Document | null = null
      status = 200
      responseText = JSON.stringify({
        attachments: [{
          id: "uploaded-attachment",
          kind: "file",
          displayName: "notes.txt",
          absolutePath: "/project/.stillon/uploads/notes.txt",
          relativePath: "./.stillon/uploads/notes.txt",
          contentUrl: "/api/projects/project-1/uploads/notes.txt/content",
          mimeType: "text/plain",
          size: 5,
        }],
      })
      upload = { addEventListener: () => undefined }
      private listeners = new Map<string, () => void>()

      constructor() {
        FakeXMLHttpRequest.latest = this
      }

      open(method: string, url: string) {
        this.method = method
        this.url = url
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.set(type, () => {
          if (typeof listener === "function") {
            listener(new Event(type))
          } else {
            listener.handleEvent(new Event(type))
          }
        })
      }

      getResponseHeader(name: string) {
        return name.toLowerCase() === "content-type" ? "application/json" : null
      }

      send(body: XMLHttpRequestBodyInit | Document | null) {
        this.body = body
        queueMicrotask(() => this.listeners.get("load")?.())
      }
    }

    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, "XMLHttpRequest", {
      configurable: true,
      value: FakeXMLHttpRequest,
    })

    try {
      const file = new File(["hello"], "notes.txt", { type: "text/plain" })
      const pendingAttachment = createPendingComposerAttachment(file)
      const upload = uploadProjectAttachment({ projectId: "project-1", file })

      expect(pendingAttachment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(FakeXMLHttpRequest.latest?.method).toBe("POST")
      expect(FakeXMLHttpRequest.latest?.url).toBe("/api/projects/project-1/uploads")
      expect(FakeXMLHttpRequest.latest?.body).toBeInstanceOf(FormData)
      await expect(upload).resolves.toMatchObject({
        id: "uploaded-attachment",
        displayName: "notes.txt",
      })
    } finally {
      if (randomUuidDescriptor) {
        Object.defineProperty(globalThis.crypto, "randomUUID", randomUuidDescriptor)
      } else {
        delete (globalThis.crypto as Crypto & { randomUUID?: Crypto["randomUUID"] }).randomUUID
      }

      if (xhrDescriptor) {
        Object.defineProperty(globalThis, "XMLHttpRequest", xhrDescriptor)
      } else {
        delete (globalThis as typeof globalThis & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest
      }
    }
  })
})

describe("getClipboardImageFiles", () => {
  test("returns image files from clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "pasted.png", { type: "image/png" }) }),
    ], 123)

    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe("pasted.png")
  })

  test("ignores non-image clipboard items", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ kind: "string", type: "text/plain" }),
      createClipboardItem({ type: "application/pdf", file: new File(["pdf"], "doc.pdf", { type: "application/pdf" }) }),
    ], 123)

    expect(files).toEqual([])
  })

  test("renames unnamed pasted images using the clipboard timestamp", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("preserves existing filenames from the browser", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/jpeg", file: new File(["img"], "Screenshot 1.jpg", { type: "image/jpeg" }) }),
    ], 456)

    expect(files[0]?.name).toBe("Screenshot 1.jpg")
  })

  test("rewrites generic browser clipboard filenames", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["img"], "image.png", { type: "image/png" }) }),
    ], 456)

    expect(files[0]?.name).toBe("clipboard-456.png")
  })

  test("generates distinct names for multiple unnamed images in one paste event", () => {
    const files = getClipboardImageFiles([
      createClipboardItem({ type: "image/png", file: new File(["a"], "", { type: "image/png" }) }),
      createClipboardItem({ type: "image/webp", file: new File(["b"], "", { type: "image/webp" }) }),
    ], 789)

    expect(files.map((file) => file.name)).toEqual([
      "clipboard-789.png",
      "clipboard-789-1.webp",
    ])
  })
})

describe("trimTrailingPastedNewlines", () => {
  test("removes trailing unix newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\n\n")).toBe("hello")
  })

  test("removes trailing windows newlines from pasted text", () => {
    expect(trimTrailingPastedNewlines("hello\r\n\r\n")).toBe("hello")
  })

  test("preserves internal newlines", () => {
    expect(trimTrailingPastedNewlines("hello\nworld\n")).toBe("hello\nworld")
  })

  test("leaves text without trailing newlines unchanged", () => {
    expect(trimTrailingPastedNewlines("hello")).toBe("hello")
  })
})

describe("isDesktopLikeInputDevice", () => {
  function matchMediaFor(matches: Record<string, boolean>) {
    return (query: string) => ({ matches: matches[query] ?? false })
  }

  test("treats touch computers with a fine pointer as desktop-like", () => {
    expect(isDesktopLikeInputDevice({
      matchMedia: matchMediaFor({ "(any-pointer: fine)": true }),
      hasTouchStart: true,
      maxTouchPoints: 10,
    })).toBe(true)
  })

  test("treats hover-capable devices as desktop-like", () => {
    expect(isDesktopLikeInputDevice({
      matchMedia: matchMediaFor({ "(any-hover: hover)": true }),
      hasTouchStart: true,
      maxTouchPoints: 10,
    })).toBe(true)
  })

  test("keeps touch-only phones and tablets out of desktop Enter submit behavior", () => {
    expect(isDesktopLikeInputDevice({
      matchMedia: matchMediaFor({}),
      hasTouchStart: true,
      maxTouchPoints: 5,
    })).toBe(false)
  })

  test("falls back to desktop-like when matchMedia is unavailable and no touch support is reported", () => {
    expect(isDesktopLikeInputDevice({
      hasTouchStart: false,
      maxTouchPoints: 0,
    })).toBe(true)
  })
})

describe("ChatInput", () => {
  test("renders the composer on an opaque surface", () => {
    const html = renderToStaticMarkup(createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      canCancel: false,
      activeProvider: null,
      availableProviders: PROVIDERS,
    }))

    expect(html).toContain("bg-background")
    expect(html).not.toContain("dark:bg-card/40")
    expect(html).not.toContain("backdrop-blur-lg")
  })

  test("renders the attachment trigger as a native file input target", () => {
    const html = renderToStaticMarkup(createElement(ChatInput, {
      onSubmit: async () => undefined,
      disabled: false,
      canCancel: false,
      activeProvider: null,
      availableProviders: PROVIDERS,
    }))

    expect(html).toContain('aria-label="Add attachment"')
    expect(html).toContain('type="file"')
    expect(html).toContain("absolute inset-0 cursor-pointer opacity-0")
    expect(html).not.toContain('type="file" multiple="" class="hidden"')
  })
})
