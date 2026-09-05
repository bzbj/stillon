type ClipboardWriter = Pick<Clipboard, "writeText">

type CopyTextEnvironment = {
  clipboard?: ClipboardWriter | null
  document?: Document | null
}

export async function copyTextToClipboard(
  text: string,
  environment: CopyTextEnvironment = {}
): Promise<boolean> {
  const clipboard = environment.clipboard === undefined
    ? typeof navigator === "undefined" ? null : navigator.clipboard
    : environment.clipboard

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the synchronous copy path used by non-secure origins.
    }
  }

  const documentRef = environment.document === undefined
    ? typeof document === "undefined" ? null : document
    : environment.document
  if (!documentRef?.body || typeof documentRef.execCommand !== "function") return false

  const previousActiveElement = documentRef.activeElement
  let textarea: HTMLTextAreaElement | null = null

  try {
    textarea = documentRef.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.setAttribute("aria-hidden", "true")
    textarea.style.position = "fixed"
    textarea.style.inset = "0 auto auto -9999px"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    documentRef.body.append(textarea)
    textarea.focus()
    textarea.select()
    return documentRef.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea?.remove()
    if (typeof HTMLElement !== "undefined" && previousActiveElement instanceof HTMLElement) {
      previousActiveElement.focus({ preventScroll: true })
    }
  }
}
