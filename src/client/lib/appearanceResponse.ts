/** Proxies and expired login gateways can return text or HTML instead of JSON. */
export async function readAppearanceResponse(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session has expired. Sign in again, then retry the appearance change.")
    if (response.status === 403) throw new Error("The appearance request was blocked (HTTP 403). Reload StillOn from its trusted address, then try again.")
    throw new Error(typeof value?.error === "string" ? value.error : `The appearance request failed (HTTP ${response.status}). Please try again.`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("StillOn returned an invalid appearance response. Your appearance has not changed. Reload and try again.")
  }
  return value
}
