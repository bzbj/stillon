import { useEffect, type RefObject } from "react"
import {
  hasActiveFocusOverlay,
  hasActiveTextSelection,
  RESTORE_CHAT_INPUT_FOCUS_EVENT,
  resolveChatFocusAction,
} from "./chatFocusPolicy"

interface StickyChatFocusOptions {
  rootRef: RefObject<HTMLElement | null>
  fallbackRef: RefObject<HTMLTextAreaElement | null>
  enabled: boolean
  canCancel: boolean
}

export function useStickyChatFocus({ rootRef, fallbackRef, enabled, canCancel }: StickyChatFocusOptions) {
  useEffect(() => {
    if (!enabled) return

    let rafId = 0
    let pointerStartTarget: Element | null = null

    const restoreFocusIfNeeded = (pointerEndTarget: EventTarget | null) => {
      const target = pointerEndTarget instanceof Element ? pointerEndTarget : null
      const root = rootRef.current
      const fallback = fallbackRef.current

      if (resolveChatFocusAction({
        trigger: "pointer",
        activeElement: document.activeElement,
        pointerStartTarget,
        pointerEndTarget: target,
        root,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        hasActiveSelection: hasActiveTextSelection(window.getSelection()),
      }) !== "restore") {
        pointerStartTarget = null
        return
      }

      fallback?.focus({ preventScroll: true })
      pointerStartTarget = null
    }

    const handlePointerDown = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      pointerStartTarget = event.target instanceof Element ? event.target : null
    }

    const handlePointerUp = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        restoreFocusIfNeeded(event.target)
      })
    }

    const handleRestoreFocus = () => {
      pointerStartTarget = null
      const fallback = fallbackRef.current
      if (!fallback || fallback.disabled) return
      fallback.focus({ preventScroll: true })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return

      const fallback = fallbackRef.current
      if (resolveChatFocusAction({
        trigger: "escape",
        activeElement: document.activeElement,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        canCancel,
        defaultPrevented: event.defaultPrevented,
      }) !== "escape-focus") {
        return
      }

      event.preventDefault()
      fallback?.focus({ preventScroll: true })
    }

    window.addEventListener("pointerdown", handlePointerDown, true)
    window.addEventListener("pointerup", handlePointerUp, true)
    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener("pointerdown", handlePointerDown, true)
      window.removeEventListener("pointerup", handlePointerUp, true)
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    }
  }, [canCancel, enabled, fallbackRef, rootRef])
}
