import { describe, expect, test } from "bun:test"
import { getUploadProgress, getUploadXhrResponseError } from "./ChatInput"

describe("upload progress", () => {
  test("converts length-computable browser progress events to a bounded percentage", () => {
    expect(getUploadProgress({ lengthComputable: true, loaded: 45, total: 120 })).toBe(38)
    expect(getUploadProgress({ lengthComputable: true, loaded: 150, total: 100 })).toBe(100)
  })

  test("keeps the indeterminate state when the browser cannot calculate upload length", () => {
    expect(getUploadProgress({ lengthComputable: false, loaded: 1, total: 0 })).toBeUndefined()
  })

  test("preserves server upload errors from XHR responses", () => {
    expect(getUploadXhrResponseError({
      status: 413,
      contentType: "application/json",
      responseText: JSON.stringify({ error: "File exceeds the 100 MB limit." }),
    })).toBe("File exceeds the 100 MB limit.")
  })

  test("provides an actionable message when an access proxy returns HTML", () => {
    expect(getUploadXhrResponseError({
      status: 200,
      contentType: "text/html",
      responseText: "<html>sign in</html>",
      requestId: "abc123-SIN",
    })).toBe(
      "The upload returned an unexpected page (HTTP 200). Reload this page and try again. Request ID: abc123-SIN."
    )
  })
})

for (const status of [200, 401, 403, 404, 413, 502]) {
  test(`HTML ${status} does not claim Cloudflare blocked the upload`, () => {
    const message = getUploadXhrResponseError({ status, contentType: "text/html", responseText: "<html>Error</html>" })
    expect(message).not.toContain("Cloudflare")
    if (status === 404) expect(message).toContain("computer is online")
  })
}

test("identifies an explicit Cloudflare challenge", () => {
  expect(getUploadXhrResponseError({ status: 403, contentType: "text/html", responseText: "<html>Verify</html>", challenged: true, requestId: "ray" })).toContain("Cloudflare requires verification")
})
