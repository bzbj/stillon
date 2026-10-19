import { expect, test } from "bun:test"
import { ConnectFilePreviews } from "./file-previews"
import type { HostSessionRecord } from "./registry"

test("file origins stay stable within an authorized directory and isolate sessions and other directories", () => {
  let valid = true
  const previews = new ConnectFilePreviews("https://connect.stillon.example", () => valid)
  const session = { id: "session", hostId: "a".repeat(32), parentId: "parent", ownerId: "owner" } as HostSessionRecord
  const first = new URL(previews.start(session, "target-one", "/index.html?q=1", "a".repeat(64)))
  const next = new URL(previews.start(session, "target-two", "/next.html", "a".repeat(64)))
  expect(first.origin).toBe(next.origin)
  expect(previews.resolve(first.host)?.targetId).toBe("target-two")
  expect(new URL(previews.start(session, "target-three", "/index.html", "b".repeat(64))).origin).not.toBe(first.origin)
  expect(new URL(previews.start({ ...session, id: "other-session" }, "target-one", "/index.html", "a".repeat(64))).origin).not.toBe(first.origin)
  valid = false
  expect(previews.resolve(first.host)).toBeNull()
  previews.clear()
})
