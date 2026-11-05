import { useCallback, useEffect, useRef, useState, type DragEvent } from "react"
import { hasFileDragTypes } from "../app/ChatPage/utils"

export function usePageFileDrop(args: {
  hasSelectedProject: boolean
  onFilesDropped: (files: File[]) => void
}) {
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const pageFileDragDepthRef = useRef(0)

  const resetFileDrag = useCallback(() => {
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
  }, [])

  useEffect(() => {
    resetFileDrag()
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") resetFileDrag()
    }
    window.addEventListener("drop", resetFileDrag)
    window.addEventListener("dragend", resetFileDrag)
    window.addEventListener("blur", resetFileDrag)
    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("drop", resetFileDrag)
      window.removeEventListener("dragend", resetFileDrag)
      window.removeEventListener("blur", resetFileDrag)
      window.removeEventListener("keydown", handleEscape)
    }
  }, [args.hasSelectedProject, resetFileDrag])

  const hasDraggedFiles = useCallback((event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? []), [])

  const handleTranscriptDragEnter = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current += 1
    setIsPageFileDragActive(true)
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDragOver = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!isPageFileDragActive) {
      setIsPageFileDragActive(true)
    }
  }, [args.hasSelectedProject, hasDraggedFiles, isPageFileDragActive])

  const handleTranscriptDragLeave = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
    if (pageFileDragDepthRef.current === 0) {
      setIsPageFileDragActive(false)
    }
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDrop = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
    args.onFilesDropped([...event.dataTransfer.files])
  }, [args, hasDraggedFiles])

  return {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  }
}

