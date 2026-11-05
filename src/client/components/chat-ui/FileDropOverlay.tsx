import { Upload } from "lucide-react"

export function FileDropOverlay({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/60 text-white backdrop-blur-sm"
    >
      <Upload aria-hidden="true" className="size-14" strokeWidth={1.75} />
      <div className="text-xl font-medium">Drop files to upload</div>
    </div>
  )
}
