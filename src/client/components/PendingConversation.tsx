import { File, Loader2 } from "lucide-react"
import type { ChatAttachment } from "../../shared/types"

/** Render synchronously without loading the full transcript renderer. */
export function PendingConversation({ content, attachments = [] }: { content: string; attachments?: ChatAttachment[] }) {
  return (
    <section aria-label="Starting conversation" className="mb-8 space-y-4 px-3">
      <div className="flex flex-col items-end gap-2">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="flex max-w-[85%] items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2 text-sm">
            <File aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 break-all">{attachment.displayName}</span>
          </div>
        ))}
        {content ? (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] border border-border bg-muted px-3.5 py-1.5 text-sm text-primary sm:max-w-[80%]">
            {content}
          </div>
        ) : null}
      </div>
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Starting conversation…
      </div>
    </section>
  )
}
