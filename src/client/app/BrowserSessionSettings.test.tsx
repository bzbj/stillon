import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { BrowserSessionList, sessionTimeRemaining } from "./BrowserSessionSettings"

test("expiry labels use server time and handle a session's last day", () => {
  expect(sessionTimeRemaining(1_000, 1_001)).toBe("Expired")
  expect(sessionTimeRemaining(3_600_001, 1)).toBe("Less than 1 day remaining")
  expect(sessionTimeRemaining(86_400_001, 1)).toBe("1 day remaining")
  expect(sessionTimeRemaining(30 * 86_400_000, 1)).toBe("30 days remaining")
})

test("the browser list identifies this device and unknown historical usage", () => {
  const html = renderToStaticMarkup(<BrowserSessionList data={{ now: 1_000, sessions: [
    { id: "one", browser: "Safari", platform: "iOS", createdAt: 1, expiresAt: 86_401_000, lastUsedAt: null, current: true },
    { id: "two", browser: "Firefox", platform: "Windows", createdAt: 1, expiresAt: 90_000, lastUsedAt: 1_000, current: false },
  ] }} busy={null} confirming={null} onConfirm={() => {}} onRemove={() => {}} />)
  expect(html).toContain("2 active browser logins")
  expect(html.match(/>This device</g)).toHaveLength(1)
  expect(html).toContain("Not recorded yet")
  expect(html).toContain("1 day remaining")
  expect(html).toContain("Less than 1 day remaining")
  expect(html).toContain("Sign out Safari on iOS (this device)")
})
