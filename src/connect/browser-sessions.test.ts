import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BrowserSessions, browserDescription, browserCommandActivity } from "./browser-sessions"

test("browser logins exclude expired/revoked sessions, isolate owners and persist throttled usage", () => {
  const db = new Database(":memory:"), activity = new Database(":memory:")
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,createdAt INTEGER,expiresAt INTEGER,userAgent TEXT)")
  const add = db.query("INSERT INTO session VALUES (?,?,?,?,?)")
  add.run("a", "owner", 1, 200_000, "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36")
  add.run("b", "owner", 2, 200_000, "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0")
  add.run("expired", "owner", 3, 10, "")
  add.run("revoked", "owner", 4, 200_000, "")
  add.run("foreign", "other", 5, 200_000, "")
  let now = 1_000
  try {
    let sessions = new BrowserSessions(db, activity, id => id === "revoked", () => now)
    expect(sessions.list("owner", "a").sessions.map(s => s.id)).toEqual(["a", "b"])
    expect(sessions.list("owner").sessions.every(s => !s.current)).toBe(true)
    expect(sessions.list("owner").sessions[0]!.lastUsedAt).toBeNull()
    sessions.touch("a")
    now = 30_000; sessions.touch("a")
    expect(sessions.list("owner", "a").sessions[0]!.lastUsedAt).toBe(1_000)
    now = 61_001; sessions.touch("a")
    sessions = new BrowserSessions(db, activity, id => id === "revoked", () => now)
    expect(sessions.list("owner", "a").sessions[0]).toMatchObject({ lastUsedAt: 61_001, current: true, browser: "Chrome", platform: "macOS" })
    expect(Object.keys(sessions.list("owner").sessions[0]!).sort()).toEqual(["browser", "createdAt", "current", "expiresAt", "id", "lastUsedAt", "platform"])
    db.query("DELETE FROM session WHERE id='a'").run()
    new BrowserSessions(db, activity, () => false)
    expect(activity.query("SELECT * FROM connect_session_activity WHERE sessionId='a'").get()).toBeNull()
  } finally { db.close(); activity.close() }
})

test("browser labels use bounded descriptions rather than raw user-agent markup", () => {
  expect(browserDescription("Mozilla/5.0 (Windows) Chrome/140 Safari/537 Edg/140")).toEqual({ browser: "Edge", platform: "Windows" })
  expect(browserDescription("Mozilla/5.0 (iPhone) FxiOS/142 Safari/605")).toEqual({ browser: "Firefox", platform: "iOS" })
  expect(browserDescription("<script>alert(1)</script>")).toEqual({ browser: "Browser", platform: "Unknown device" })
})

test("connection heartbeats and subscriptions do not count as browser command activity", () => {
  expect(browserCommandActivity(JSON.stringify({ type: "command", command: { type: "system.ping" } }))).toBe(false)
  expect(browserCommandActivity(JSON.stringify({ type: "subscribe" }))).toBe(false)
  expect(browserCommandActivity("malformed")).toBe(false)
  expect(browserCommandActivity(Buffer.from(JSON.stringify({ type: "command", command: { type: "terminal.input" } })))).toBe(true)
})
