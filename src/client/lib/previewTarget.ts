export async function registerPreviewTarget(address: string, projectId?: string) {
  const response = await fetch("/api/preview-targets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, projectId }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.url !== "string" || !/^\/preview\/[\w-]+$/u.test(body.url)) throw new Error(body.error || "This server does not support standalone previews. Update StillOn and retry.")
  return body.url as string
}

export async function openStandalonePreview(address: string, projectId?: string) {
  // Reserve the tab during the user gesture, before asynchronous authorization.
  const tab = window.open("about:blank", "_blank")
  if (tab) tab.opener = null
  try {
    const url = await registerPreviewTarget(address, projectId)
    if (tab) tab.location.replace(url)
    else window.location.assign(url)
  } catch (error) { tab?.close(); throw error }
}
