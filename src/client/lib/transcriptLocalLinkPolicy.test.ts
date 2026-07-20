import { describe, expect, test } from "bun:test"
import {
  resolveDirectLocalFileAction,
  shouldBypassInAppLocalFilePreview,
} from "./transcriptLocalLinkPolicy"

describe("shouldBypassInAppLocalFilePreview", () => {
  test("opens local file links through the host system during loopback access", () => {
    expect(shouldBypassInAppLocalFilePreview("127.0.0.1")).toBe(true)
    expect(shouldBypassInAppLocalFilePreview("localhost")).toBe(true)
    expect(shouldBypassInAppLocalFilePreview("::1")).toBe(true)
    expect(shouldBypassInAppLocalFilePreview("[::1]")).toBe(true)
  })

  test("keeps in-app file previews available during remote access", () => {
    expect(shouldBypassInAppLocalFilePreview("stillon.example.com")).toBe(false)
    expect(shouldBypassInAppLocalFilePreview("192.168.1.20")).toBe(false)
  })

  test("opens renderable documents with the system default app during direct access", () => {
    expect(resolveDirectLocalFileAction("C:/project/report.html", "open_editor")).toBe("open_default")
    expect(resolveDirectLocalFileAction("C:/project/README.md", "open_editor")).toBe("open_default")
    expect(resolveDirectLocalFileAction("C:/project/report.xlsx", "open_default")).toBe("open_default")
    expect(resolveDirectLocalFileAction("C:/project/app.ts", "open_editor")).toBe("open_editor")
  })
})
