import { useEffect, useState, type FormEvent } from "react"
import { Check, Copy, LoaderCircle, Users } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { useWorkspaceSharingStore } from "../stores/workspaceSharingStore"

export function WorkspaceShareDialog({ workspaceId, title, open, onOpenChange }: { workspaceId: string; title: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { view, reload, change } = useWorkspaceSharingStore()
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<string | null>(null)
  const members = view?.workspaces.find(w => w.workspaceId === workspaceId)?.members ?? []
  useEffect(() => { if (open) void reload().catch(e => setError(e.message)) }, [open, reload])
  async function action(body: unknown) {
    setBusy(true); setError("")
    try { const result = await change(body); setEmail(""); setNotice(result.invitationUrl ? result.delivery === "sent" ? "Invitation email sent. You can also copy the link below." : result.delivery === "unavailable" ? "Invitation created. Email delivery failed; copy the invitation link below." : "Invitation created. Copy the invitation link below." : "") }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to update sharing.") }
    finally { setBusy(false) }
  }
  function invite(event: FormEvent) { event.preventDefault(); void action({ operation: "invite", workspaceId, email: email.trim() }) }
  async function copy(id: string, url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(id) }
    catch { setError("Unable to copy the invitation link. Please try again.") }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-[calc(100vw-32px)] sm:max-w-md">
    <DialogHeader><DialogTitle className="flex items-center gap-2 pr-6"><Users className="size-4 shrink-0" /><span className="truncate">Share · {title}</span></DialogTitle><DialogDescription>Work together in this workspace. Conversations, interruptions and archived chats are shared with everyone.</DialogDescription></DialogHeader>
    <div className="space-y-5 overflow-y-auto p-4">
      {view?.configured === false ? <div className="space-y-3"><p className="text-sm text-muted-foreground">Link this computer to your email to invite people.</p><a href="/settings/remote" className="text-sm underline">Open Remote access settings →</a></div> : <>
        <form onSubmit={invite} className="flex gap-2"><Input aria-label="Invite email address" type="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} disabled={busy || !view} /><Button type="submit" disabled={busy || !view || !email.trim()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : "Invite"}</Button></form>
        <div className="space-y-1" aria-label="Invited people">{members.length ? members.map(member => <div key={member.id} className="flex items-center gap-2 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm" title={member.email}>{member.email}</p><p className="mt-1 text-xs text-muted-foreground">{member.status === "joined" ? "Joined" : "Pending acceptance"}</p></div><Button variant="ghost" size="icon" title="Copy invitation link" aria-label={`Copy invitation for ${member.email}`} onClick={() => void copy(member.id, member.invitationUrl)}>{copied === member.id ? <Check className="size-4" /> : <Copy className="size-4" />}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void action({ operation: "remove", workspaceId, memberId: member.id })}>{member.status === "joined" ? "Remove" : "Revoke"}</Button></div>) : <p className="py-5 text-center text-sm text-muted-foreground">Only you have access. Invite someone to work together.</p>}</div>
        {members.length ? <div className="border-t pt-4"><Button variant="outline" disabled={busy} className="text-destructive" onClick={() => void action({ operation: "stop", workspaceId })}>Stop sharing</Button><p className="mt-2 text-xs text-muted-foreground">Remove everyone's access. Conversations and files stay here.</p></div> : null}
      </>}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {error ? <div role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={() => { setError(""); void reload().catch(e => setError(e.message)) }}>Retry</button></div> : null}
    </div>
  </DialogContent></Dialog>
}
