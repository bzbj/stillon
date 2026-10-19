import { lazy, Suspense } from "react"
import type { ChatAttachment } from "../../../shared/types"

const LoadedAttachmentPreviewModal = lazy(() => import("./AttachmentPreviewModal").then(module => ({ default: module.AttachmentPreviewModal })))

export function AttachmentPreviewModal({ attachment, onOpenChange }: { attachment: ChatAttachment | null; onOpenChange: (open: boolean) => void }) {
  if (!attachment) return null
  return <Suspense fallback={<p role="status" className="p-4 text-sm">Loading attachment preview… <button type="button" className="underline" onClick={() => onOpenChange(false)}>Cancel</button></p>}>
    <LoadedAttachmentPreviewModal attachment={attachment} onOpenChange={onOpenChange} />
  </Suspense>
}
