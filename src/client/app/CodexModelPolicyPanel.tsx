import { useState } from "react"
import { useCodexModelPolicyStore } from "../stores/codexModelPolicyStore"
import type { CodexModelPolicySnapshot } from "../../shared/codex-model-policy"
import type { StillOnSocket } from "./socket"
import { Button } from "../components/ui/button"

export function CodexModelPolicyPanel({ socket, connected }: { socket: StillOnSocket; connected: boolean }) {
  const snapshot = useCodexModelPolicyStore((store) => store.snapshot)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function update(target?: "previous" | "builtin") {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await socket.command<CodexModelPolicySnapshot>(target
        ? { type: "settings.restoreCodexModelPolicy", target }
        : { type: "settings.refreshCodexModelPolicy" })
      setMessage(target ? "Model configuration restored." : "Model configuration refreshed. No rebuild needed.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex w-full max-w-[420px] flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Update the local configuration, then refresh to use new models across connected devices.
        Active turns keep their current model.
      </p>
      {snapshot ? <>
        <code className="break-all text-xs text-muted-foreground">{snapshot.filePath}</code>
        <p className="text-xs text-muted-foreground">
          {snapshot.source === "builtin" ? "Bundled defaults" : snapshot.source === "local" ? "Local configuration" : "Last valid configuration"}
          {" · "}{snapshot.policy.models.length} models
        </p>
      </> : <p className="text-sm text-muted-foreground">Loading model configuration…</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!connected || pending || !snapshot} onClick={() => void update()}>
          {pending ? "Updating…" : "Refresh models"}
        </Button>
        <Button size="sm" variant="outline" disabled={!connected || pending || !snapshot?.canRestore} onClick={() => void update("previous")}>
          Restore previous
        </Button>
        <Button size="sm" variant="ghost" disabled={!connected || pending || !snapshot} onClick={() => void update("builtin")}>
          Use bundled defaults
        </Button>
      </div>
      {error || snapshot?.warning ? <p role="alert" className="break-words text-sm text-destructive">{error || snapshot?.warning}</p> : null}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  )
}
