import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatAttachment } from "../../../shared/types"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"

const imageAttachment: ChatAttachment = {
  id: "attachment-image",
  kind: "image",
  displayName: "diagram.png",
  absolutePath: "",
  relativePath: "",
  contentUrl: "",
  mimeType: "image/png",
  size: 1024,
}

const fileAttachment: ChatAttachment = {
  ...imageAttachment,
  id: "attachment-file",
  kind: "file",
  displayName: "notes.pdf",
  mimeType: "application/pdf",
}

describe("composer attachment upload state", () => {
  test("shows an uploading overlay and exposes the busy state for image previews", () => {
    const html = renderToStaticMarkup(createElement(AttachmentImageCard, {
      attachment: imageAttachment,
      uploadState: "uploading",
      uploadProgress: 42,
      size: "composer",
      onRemove: () => undefined,
    }))

    expect(html).toContain("Uploading 42%")
    expect(html).toContain("diagram.png is uploading, 42% complete")
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain("disabled")
  })

  test("shows a failed state while retaining the remove action for files", () => {
    const html = renderToStaticMarkup(createElement(AttachmentFileCard, {
      attachment: fileAttachment,
      uploadState: "failed",
      onRemove: () => undefined,
    }))

    expect(html).toContain("Upload failed")
    expect(html).toContain("notes.pdf failed to upload")
    expect(html).toContain('aria-label="Remove notes.pdf"')
    expect(html).toContain("disabled")
  })

  test("keeps the attachment visibly processing after its bytes finish uploading", () => {
    const html = renderToStaticMarkup(createElement(AttachmentImageCard, {
      attachment: imageAttachment,
      uploadState: "uploading",
      uploadProgress: 100,
      size: "composer",
    }))

    expect(html).toContain("Processing")
    expect(html).toContain("diagram.png upload is processing")
    expect(html).toContain('aria-valuetext="Upload complete; processing attachment"')
  })
})
