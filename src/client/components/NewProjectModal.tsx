import { useState, useEffect, useRef, useCallback } from "react"
import { ChevronLeft, ChevronRight, Folder, Home, Loader2 } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import { workspaceFolderNameError } from "../../shared/workspace-folders"
import type { LocalDirectoryListResult, ResolvedLocalPath } from "../../shared/protocol"
import { getPathBasename } from "../lib/formatters"
import { appendLocalPathSegment } from "../lib/localPaths"
import { Button } from "./ui/button"
import { Dialog, DialogContent, DialogBody, DialogTitle, DialogFooter, DialogDescription } from "./ui/dialog"
import { Input } from "./ui/input"
import { ScrollArea } from "./ui/scroll-area"
import { SegmentedControl } from "./ui/segmented-control"

type Tab = "new" | "existing"
interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (workspace: { mode: Tab; localPath: string; title: string }) => void | Promise<void>
  onListDirectories?: (localPath?: string) => Promise<LocalDirectoryListResult>
  onResolveLocalPath: (localPath: string) => Promise<ResolvedLocalPath>
  machineName?: string
}

export function NewProjectModal({ open, onOpenChange, onConfirm, onListDirectories, onResolveLocalPath, machineName }: Props) {
  const [tab, setTab] = useState<Tab>("existing")
  const [name, setName] = useState("")
  const [location, setLocation] = useState(DEFAULT_NEW_PROJECT_ROOT)
  const [resolvedLocation, setResolvedLocation] = useState<ResolvedLocalPath | null>(null)
  const [existingPath, setExistingPath] = useState("")
  const [directoryList, setDirectoryList] = useState<LocalDirectoryListResult | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    if (!open) return
    setTab("existing"); setName(""); setExistingPath("")
    setLocation(DEFAULT_NEW_PROJECT_ROOT); setDirectoryList(null); setResolvedLocation(null)
    setDirectoryError(null); setLocationError(null); setSubmitError(null); setBrowsing(false)
    setDirectoryLoading(false); setSubmitting(false)
    requestId.current++
  }, [open])

  useEffect(() => {
    if (!open || tab !== "new") return
    let cancelled = false
    setResolvedLocation(null); setLocationError(null)
    const timer = setTimeout(() => {
      void onResolveLocalPath(location).then(result => {
        if (!cancelled) setResolvedLocation(result)
      }).catch(error => { if (!cancelled) setLocationError(error instanceof Error ? error.message : String(error)) })
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, tab, location, onResolveLocalPath])

  const loadDirectory = useCallback(async (localPath: string, target: Tab) => {
    if (!onListDirectories) return
    const id = ++requestId.current
    setDirectoryLoading(true); setDirectoryError(null); setBrowsing(true)
    try {
      const result = await onListDirectories(localPath || "~")
      if (requestId.current !== id) return
      setDirectoryList(result)
      if (target === "existing") setExistingPath(result.path)
      else setLocation(result.path)
    } catch (error) {
      if (requestId.current === id) setDirectoryError(error instanceof Error ? error.message : String(error))
    } finally { if (requestId.current === id) setDirectoryLoading(false) }
  }, [onListDirectories])

  useEffect(() => {
    if (open && tab === "existing" && onListDirectories) void loadDirectory("~", "existing")
    return () => { requestId.current++ }
  }, [open, tab, onListDirectories, loadDirectory])

  const nameError = name ? workspaceFolderNameError(name.trim(), resolvedLocation?.separator ?? "/") : null
  const newPath = name.trim() && resolvedLocation && !nameError ? appendLocalPathSegment(resolvedLocation, name.trim()) : ""
  const canSubmit = !submitting && (tab === "new" ? Boolean(newPath) : Boolean(existingPath.trim()))
  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true); setSubmitError(null)
    try {
      await onConfirm(tab === "new"
        ? { mode: "new", localPath: newPath, title: name.trim() }
        : { mode: "existing", localPath: existingPath.trim(), title: getPathBasename(existingPath.trim()) })
      onOpenChange(false)
    } catch (error) { setSubmitError(error instanceof Error ? error.message : String(error)) }
    finally { setSubmitting(false) }
  }
  const browse = () => void loadDirectory(tab === "new" ? location : existingPath || "~", tab)
  const browser = browsing && onListDirectories ? <div className="overflow-hidden rounded-lg border border-border bg-card">
    <div className="flex items-center gap-1 border-b border-border px-2 py-2">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Home folder" disabled={directoryLoading} onClick={() => void loadDirectory("~", tab)}><Home className="size-4" /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Parent folder" disabled={directoryLoading || !directoryList?.parentPath} onClick={() => void loadDirectory(directoryList!.parentPath!, tab)}><ChevronLeft className="size-4" /></Button>
      <span className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground">{directoryList?.path ?? "Choose a folder"}</span>
      {directoryLoading && <Loader2 className="size-4 animate-spin" />}
    </div>
    <ScrollArea className="max-h-48"><div className="p-1">{directoryList?.entries.map(entry => <button key={entry.path} type="button" disabled={directoryLoading} title={entry.path} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void loadDirectory(entry.path, tab)}><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{entry.name}</span><ChevronRight className="size-4 shrink-0" /></button>)}{!directoryLoading && directoryList?.entries.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">No child folders</p>}</div></ScrollArea>
  </div> : null

  return <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}><DialogContent size="sm">
    <DialogBody className="flex flex-col gap-4">
      <DialogTitle>Open Workspace</DialogTitle>
      <DialogDescription>Select a folder to use as your agent workspace.</DialogDescription>
      <p className="text-xs text-muted-foreground">Folders on {machineName || "the connected computer"}</p>
      <SegmentedControl value={tab} onValueChange={value => { if (!submitting) { setTab(value); setBrowsing(false); setSubmitError(null); setDirectoryError(null) } }} options={[{ value: "existing" as Tab, label: "Existing Folder" }, { value: "new" as Tab, label: "New Folder" }]} className="w-full" optionClassName="flex-1 justify-center" />
      {tab === "new" ? <>
        <label className="text-sm font-medium" htmlFor="workspace-folder-name">Folder name</label>
        <Input id="workspace-folder-name" autoFocus value={name} disabled={submitting} placeholder="财务分析" onChange={event => { setName(event.target.value); setSubmitError(null) }} onKeyDown={event => { if (event.key === "Enter") void handleSubmit() }} aria-invalid={Boolean(nameError)} />
        {nameError && <p role="alert" className="text-xs text-destructive">{nameError}</p>}
        <label className="text-sm font-medium" htmlFor="workspace-folder-location">Location</label>
        <div className="flex gap-2"><Input id="workspace-folder-location" value={location} disabled={submitting} onChange={event => { setLocation(event.target.value); setSubmitError(null) }} /><Button type="button" variant="outline" size="icon" aria-label="Browse location" disabled={!onListDirectories || directoryLoading || submitting} onClick={browse}><Folder className="size-4" /></Button></div>
        {locationError && <p role="alert" className="text-xs text-destructive">{locationError}</p>}
        <p className="break-all text-xs text-muted-foreground">{newPath ? <>Create folder: <span className="font-mono">{newPath}</span></> : "Choose a location and enter the folder name."}</p>
      </> : <>
        <label className="text-sm font-medium" htmlFor="workspace-folder-path">Folder</label>
        <div className="flex gap-2"><Input id="workspace-folder-path" autoFocus value={existingPath} disabled={submitting} placeholder="~/Documents" onChange={event => { setExistingPath(event.target.value); setSubmitError(null) }} onKeyDown={event => { if (event.key === "Enter") void handleSubmit() }} /><Button type="button" variant="outline" size="icon" aria-label="Browse folder" disabled={!onListDirectories || directoryLoading || submitting} onClick={browse}><Folder className="size-4" /></Button></div>
        <p className="text-xs leading-5 text-muted-foreground">Choose an existing folder. Its files and previous conversations stay here.</p>
      </>}
      {browser}
      {directoryError && <p role="alert" className="text-xs text-destructive">{directoryError}</p>}
      {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
    </DialogBody>
    <DialogFooter><Button variant="ghost" size="sm" disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</Button><Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>{submitting && <Loader2 className="mr-2 size-4 animate-spin" />}{tab === "new" ? "Create & Open" : "Open Workspace"}</Button></DialogFooter>
  </DialogContent></Dialog>
}
