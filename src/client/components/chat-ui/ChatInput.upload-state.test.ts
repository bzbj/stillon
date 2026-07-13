import { describe, expect, test } from "bun:test"
import { getComposerUploadActivityNotice, getComposerUploadState } from "./ChatInput"

describe("getComposerUploadState", () => {
  test("keeps the composer blocked while uploads are queued before their previews render", () => {
    const state = getComposerUploadState({
      pendingUploadCount: 1,
      attachmentStatuses: [],
    })

    expect(state.visiblePendingUploadCount).toBe(1)
    expect(state.hasPendingUploads).toBe(true)
    expect(state.hasBlockingUploads).toBe(true)
  })

  test("keeps the composer blocked after an upload fails until the attachment is resolved", () => {
    const state = getComposerUploadState({
      pendingUploadCount: 0,
      attachmentStatuses: ["uploaded", "failed"],
    })

    expect(state.hasPendingUploads).toBe(false)
    expect(state.hasFailedUploads).toBe(true)
    expect(state.hasBlockingUploads).toBe(true)
  })
})
describe("getComposerUploadActivityNotice", () => {
  test("describes the queued upload state before attachment previews render", () => {
    expect(getComposerUploadActivityNotice({
      pendingUploadCount: 2,
      attachmentStates: [],
    })).toEqual({
      state: "uploading",
      message: "Uploading 2 attachments. Sending is disabled until upload finishes.",
    })
  })

  test("keeps sending blocked while bytes have uploaded and the server is processing", () => {
    expect(getComposerUploadActivityNotice({
      pendingUploadCount: 2,
      attachmentStates: [
        { status: "uploading", uploadProgress: 100 },
        { status: "uploading", uploadProgress: 100 },
      ],
    })).toEqual({
      state: "processing",
      message: "Processing 2 attachments. Sending is disabled while we confirm the upload.",
    })
  })

  test("does not call the state processing while a later upload is still queued", () => {
    expect(getComposerUploadActivityNotice({
      pendingUploadCount: 2,
      attachmentStates: [
        { status: "uploading", uploadProgress: 100 },
      ],
    })).toEqual({
      state: "uploading",
      message: "Uploading 2 attachments. Sending is disabled until upload finishes.",
    })
  })
})
