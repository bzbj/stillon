import { LOCAL_HTML_PREVIEW_SESSION_ENDPOINT } from "../../shared/local-file-urls"

interface LocalHtmlPreviewSessionResponse {
  url?: unknown
  error?: unknown
}

export async function requestLocalHtmlPreviewUrl(
  filePath: string,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(LOCAL_HTML_PREVIEW_SESSION_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filePath }),
  })

  let payload: LocalHtmlPreviewSessionResponse = {}
  try {
    payload = await response.json() as LocalHtmlPreviewSessionResponse
  } catch {
    // Use the status-based fallback below when a proxy returns a non-JSON error.
  }

  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : `Unable to create local HTML preview (status ${response.status}).`
    throw new Error(message)
  }

  if (
    typeof payload.url !== "string"
    || !payload.url.startsWith(`${LOCAL_HTML_PREVIEW_SESSION_ENDPOINT}/`)
  ) {
    throw new Error("The server returned an invalid local HTML preview URL.")
  }

  return payload.url
}
