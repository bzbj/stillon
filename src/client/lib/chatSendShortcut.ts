import type { ChatSendShortcut } from "../../shared/types"

export function isChatSendKey(event: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}, shortcut: ChatSendShortcut, desktop: boolean): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey
    || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return false
  if (event.ctrlKey || event.metaKey) return true
  return shortcut === "enter" && desktop
}
