export const ATTACHMENT_UPLOAD_PROTOCOL = 1
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 1024 * 1024
export const ATTACHMENT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024
export const UPLOAD_HEADERS = {
  // Application data travels through older relays; X-StillOn-* is reserved for authentication.
  protocol: "x-upload-protocol", id: "x-upload-id", offset: "x-upload-offset",
  total: "x-upload-size", digest: "x-upload-sha256",
} as const
