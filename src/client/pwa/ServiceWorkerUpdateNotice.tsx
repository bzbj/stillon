import { useEffect, useRef, useState } from "react"
import { Button } from "../components/ui/button"
import {
  createBrowserServiceWorkerUpdateManager,
  type ServiceWorkerUpdateSnapshot,
} from "./service-worker-registration"

const IDLE_SNAPSHOT: ServiceWorkerUpdateSnapshot = { status: "idle" }

export function ServiceWorkerUpdateNotice() {
  const [snapshot, setSnapshot] = useState(IDLE_SNAPSHOT)
  const managerRef = useRef<ReturnType<typeof createBrowserServiceWorkerUpdateManager>>(null)

  useEffect(() => {
    if (!import.meta.env.PROD) return

    const manager = createBrowserServiceWorkerUpdateManager()
    if (!manager) return
    managerRef.current = manager
    const unsubscribe = manager.subscribe(setSnapshot)
    void manager.start()

    return () => {
      unsubscribe()
      manager.dispose()
      managerRef.current = null
    }
  }, [])

  if (snapshot.status === "idle") return null

  const activating = snapshot.status === "activating"
  const failed = snapshot.status === "error"
  const title = "New interface ready"
  const description = failed
    ? "Still On could not activate the update. Reload to recover."
    : "Reload to use the latest Still On client."

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-[60] mx-auto flex max-w-lg items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-lg sm:left-auto"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Button
        size="sm"
        disabled={activating}
        onClick={() => managerRef.current?.activateUpdate()}
      >
        {activating ? "Updating…" : failed ? "Recover" : "Reload now"}
      </Button>
    </div>
  )
}
