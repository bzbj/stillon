import { useLayoutEffect, useRef, type ReactNode } from "react"

/** Revalidation hides private UI without discarding a still-valid workspace. */
export function AuthenticatedSessionBoundary({
  authenticated,
  checking,
  fallback,
  children,
}: {
  authenticated: boolean
  checking: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  const privatePage = useRef<ReactNode>(null)
  const shield = useRef<HTMLDialogElement>(null)
  if (authenticated) privatePage.current = children
  else if (!checking) privatePage.current = null

  useLayoutEffect(() => {
    const dialog = shield.current
    if (!dialog) return
    dialog.setAttribute("closedby", "none")
    if (checking && !dialog.open) dialog.showModal()
    else if (!checking && dialog.open) dialog.close()
  })

  // Native modal isolation covers portals too. Inline paint/geometry protect
  // private content even before the application's stylesheet arrives.
  return <>
    <dialog
      ref={shield}
      aria-label="Checking session"
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault() }}
      onClose={() => { const dialog = shield.current; if (checking && dialog?.isConnected && !dialog.open) dialog.showModal() }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-background p-0 text-foreground backdrop:bg-background"
      style={{ position: "fixed", inset: 0, margin: 0, width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", border: 0, padding: 0,
        background: "var(--background, Canvas)", color: "var(--foreground, CanvasText)" }}
    >
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground" role="status">
        Checking session…
      </div>
    </dialog>
    {authenticated || checking ? privatePage.current : fallback}
  </>
}
