import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PendingConversation } from "./PendingConversation"
import type { ChatAttachment } from "../../shared/types"

test("the first prompt stays visible with an accessible startup status", () => {
  const html = renderToStaticMarkup(createElement(PendingConversation, { content: "First line\nSecond line <script>" }))
  expect(html).toContain("First line\nSecond line &lt;script&gt;")
  expect(html).toContain('role="status"')
  expect(html).toContain("Starting conversation…")
  expect(html).toContain("whitespace-pre-wrap")
})

test("attachment-only sends display every file while waiting for a chat ID", () => {
  const attachments = ["report.txt", "diagram.png"].map((displayName, id) => ({ id: String(id), displayName }) as ChatAttachment)
  const html = renderToStaticMarkup(createElement(PendingConversation, { content: "", attachments }))
  expect(html).toContain("report.txt")
  expect(html).toContain("diagram.png")
  expect(html).toContain("Starting conversation…")
})
