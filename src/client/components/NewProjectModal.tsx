import { useState, useEffect, useRef, useCallback } from "react"
import { ChevronLeft, ChevronRight, Folder, Home, Loader2, RefreshCw } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import type { LocalDirectoryListResult, ResolvedLocalPath } from "../../shared/protocol"
import { getPathBasename } from "../lib/formatters"
import { appendLocalPathSegment, getLocalPathPrefix } from "../lib/localPaths"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { ScrollArea } from "./ui/scroll-area"
import { SegmentedControl } from "./ui/segmented-control"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: { mode: Tab; localPath: string; title: string }) => void
  onListDirectories?: (localPath?: string) => Promise<LocalDirectoryListResult>
  onResolveLocalPath: (localPath: string) => Promise<ResolvedLocalPath>
}

type Tab = "new" | "existing"

function toKebab(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function NewProjectModal({ open, onOpenChange, onConfirm, onListDirectories, onResolveLocalPath }: Props) {
  const [tab, setTab] = useState<Tab>("new")
  const [name, setName] = useState("")
  const [newProjectLocation, setNewProjectLocation] = useState<ResolvedLocalPath | null>(null)
  const [newProjectLocationLoading, setNewProjectLocationLoading] = useState(false)
  const [newProjectLocationError, setNewProjectLocationError] = useState<string | null>(null)
  const [existingPath, setExistingPath] = useState("")
  const [directoryList, setDirectoryList] = useState<LocalDirectoryListResult | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const existingInputRef = useRef<HTMLInputElement>(null)
  const newProjectLocationRequestIdRef = useRef(0)
  const directoryRequestIdRef = useRef(0)

  useEffect(() => {
    if (open) {
      setTab("new")
      setName("")
      setNewProjectLocation(null)
      setNewProjectLocationError(null)
      setNewProjectLocationLoading(false)
      setExistingPath("")
      setDirectoryList(null)
      setDirectoryError(null)
      setDirectoryLoading(false)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (tab === "new") {
          if (newProjectLocation) inputRef.current?.focus()
          return
        }
        existingInputRef.current?.focus()
      }, 0)
    }
  }, [newProjectLocation, open, tab])

  const resolveNewProjectLocation = useCallback(async () => {
    const requestId = newProjectLocationRequestIdRef.current + 1
    newProjectLocationRequestIdRef.current = requestId
    setNewProjectLocationLoading(true)
    setNewProjectLocationError(null)
    try {
      const result = await onResolveLocalPath(DEFAULT_NEW_PROJECT_ROOT)
      if (newProjectLocationRequestIdRef.current !== requestId) return
      setNewProjectLocation(result)
    } catch (error) {
      if (newProjectLocationRequestIdRef.current !== requestId) return
      setNewProjectLocation(null)
      setNewProjectLocationError(error instanceof Error ? error.message : String(error))
    } finally {
      if (newProjectLocationRequestIdRef.current === requestId) {
        setNewProjectLocationLoading(false)
      }
    }
  }, [onResolveLocalPath])

  useEffect(() => {
    if (!open) {
      newProjectLocationRequestIdRef.current += 1
      return
    }
    void resolveNewProjectLocation()
  }, [open, resolveNewProjectLocation])

  const loadDirectory = useCallback(async (localPath?: string) => {
    if (!onListDirectories) return
    const requestId = directoryRequestIdRef.current + 1
    directoryRequestIdRef.current = requestId
    setDirectoryLoading(true)
    setDirectoryError(null)
    try {
      const result = await onListDirectories(localPath || "~")
      if (directoryRequestIdRef.current !== requestId) return
      setDirectoryList(result)
      setExistingPath(result.path)
    } catch (error) {
      if (directoryRequestIdRef.current !== requestId) return
      setDirectoryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (directoryRequestIdRef.current === requestId) {
        setDirectoryLoading(false)
      }
    }
  }, [onListDirectories])

  useEffect(() => {
    if (open && tab === "existing" && onListDirectories && !directoryList && !directoryLoading && !directoryError) {
      void loadDirectory("~")
    }
  }, [directoryError, directoryList, directoryLoading, loadDirectory, onListDirectories, open, tab])

  const kebab = toKebab(name)
  const newPathPrefix = newProjectLocation ? getLocalPathPrefix(newProjectLocation) : ""
  const newPath = kebab && newProjectLocation
    ? appendLocalPathSegment(newProjectLocation, kebab)
    : ""
  const isResolvingNewProjectLocation = newProjectLocationLoading
    || (!newProjectLocation && !newProjectLocationError)
  const trimmedExisting = existingPath.trim()

  const canSubmit = tab === "new" ? !!kebab && !!newProjectLocation : !!trimmedExisting

  const handleSubmit = () => {
    if (!canSubmit) return
    if (tab === "new") {
      onConfirm({ mode: "new", localPath: newPath, title: name.trim() })
    } else {
      const folderName = getPathBasename(trimmedExisting)
      onConfirm({ mode: "existing", localPath: trimmedExisting, title: folderName })
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogBody className="flex flex-col gap-4">
          <DialogTitle>Add Project</DialogTitle>

          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "new" as Tab, label: "New Folder" },
              { value: "existing" as Tab, label: "Existing Path" },
            ]}
            className="w-full"
            optionClassName="flex-1 justify-center"
          />

          {tab === "new" ? (
            <div className="flex flex-col gap-2">
              <label className="sr-only" htmlFor="new-project-name">Project name</label>
              <div className="flex min-w-0">
                <div
                  className="flex min-w-0 max-w-[60%] shrink-0 items-center gap-2 rounded-l-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
                  title={newPathPrefix || undefined}
                >
                  {isResolvingNewProjectLocation ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : null}
                  <span className="truncate">
                    {isResolvingNewProjectLocation
                      ? "Resolving location..."
                      : newPathPrefix || "Location unavailable"}
                  </span>
                </div>
                <Input
                  id="new-project-name"
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmit()
                    if (e.key === "Escape") onOpenChange(false)
                  }}
                  placeholder="Project name"
                  aria-describedby="new-project-location-hint"
                  disabled={!newProjectLocation}
                  className="-ml-px min-w-[8rem] flex-1 rounded-l-none"
                />
              </div>
              {newProjectLocationError ? (
                <p id="new-project-location-hint" className="text-xs text-destructive">
                  Could not resolve the project location: {newProjectLocationError}
                </p>
              ) : isResolvingNewProjectLocation ? (
                <p id="new-project-location-hint" className="text-xs text-muted-foreground">
                  Resolving the project location on the connected machine...
                </p>
              ) : (
                <p id="new-project-location-hint" className="text-xs text-muted-foreground">
                  A new folder will be created at{" "}
                  <span className="break-all font-mono text-foreground">
                    {newPath || (newPathPrefix ? `${newPathPrefix}<project-name>` : "this location")}
                  </span>.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  ref={existingInputRef}
                  type="text"
                  value={existingPath}
                  onChange={(e) => setExistingPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSubmit()
                    if (e.key === "Escape") onOpenChange(false)
                  }}
                  placeholder="~/Projects/my-app"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  aria-label="Browse path"
                  title="Browse path"
                  disabled={!onListDirectories || directoryLoading}
                  onClick={() => void loadDirectory(trimmedExisting || "~")}
                >
                  {directoryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}
                </Button>
              </div>

              {onListDirectories ? (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1 border-b border-border bg-background/60 px-2 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Home"
                      title="Home"
                      disabled={directoryLoading}
                      onClick={() => void loadDirectory("~")}
                    >
                      <Home className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Parent folder"
                      title="Parent folder"
                      disabled={directoryLoading || !directoryList?.parentPath}
                      onClick={() => {
                        if (!directoryList?.parentPath) return
                        void loadDirectory(directoryList.parentPath)
                      }}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <div className="min-w-0 truncate px-2 font-mono text-xs text-muted-foreground">
                      {directoryList?.path ?? "Select a folder"}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Refresh"
                      title="Refresh"
                      disabled={directoryLoading}
                      onClick={() => void loadDirectory(directoryList?.path || trimmedExisting || "~")}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <ScrollArea className="max-h-52">
                    {directoryList?.entries.length ? (
                      <div className="p-1">
                        {directoryList.entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            title={entry.path}
                            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => void loadDirectory(entry.path)}
                          >
                            <Folder className="h-4 w-4 text-muted-foreground" />
                            <span className="truncate">{entry.name}</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {directoryLoading ? "Loading folders..." : "No child folders"}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              ) : null}

              {directoryError ? (
                <p className="text-xs text-destructive">{directoryError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Choose a folder below or type a path manually. The folder will be created if it doesn't exist.
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
