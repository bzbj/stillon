import { expect, test } from "bun:test"
import { isChatSendKey } from "./chatSendShortcut"

const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }
test("Enter follows the selected mode and touch devices retain newlines", () => {
  expect(isChatSendKey(enter, "enter", true)).toBe(true)
  expect(isChatSendKey(enter, "ctrl-enter", true)).toBe(false)
  expect(isChatSendKey(enter, "enter", false)).toBe(false)
})
test("Ctrl and Cmd send in either mode, including on touch devices", () => {
  for (const mode of ["enter", "ctrl-enter"] as const) {
    for (const modifier of ["ctrlKey", "metaKey"]) {
      expect(isChatSendKey({ ...enter, [modifier]: true }, mode, true)).toBe(true)
      expect(isChatSendKey({ ...enter, [modifier]: true }, mode, false)).toBe(true)
    }
  }
})
test("line breaks and IME confirmation never send", () => {
  for (const mode of ["enter", "ctrl-enter"] as const) {
    for (const event of [
      { ...enter, shiftKey: true, ctrlKey: true },
      { ...enter, altKey: true },
      { ...enter, key: "a", ctrlKey: true },
      { ...enter, nativeEvent: { isComposing: true } },
      { ...enter, ctrlKey: true, nativeEvent: { keyCode: 229 } },
    ]) expect(isChatSendKey(event, mode, true)).toBe(false)
  }
})
