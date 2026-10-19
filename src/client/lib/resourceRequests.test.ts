import { expect, test } from "bun:test"
import { coalesceResourceRequest, setResourceSessionScope } from "./resourceRequests"

test("concurrent preparation shares work only within the same session/project/target", async () => {
  setResourceSessionScope("session-one")
  let calls = 0, release!: (value: string) => void
  const load = () => { calls++; return new Promise<string>(resolve => { release = resolve }) }
  const first = coalesceResourceRequest("metadata", "report.html", "project-one", load)
  const second = coalesceResourceRequest("metadata", "report.html", "project-one", load)
  expect(first).toBe(second)
  expect(calls).toBe(1)
  release("ready")
  expect(await first).toBe("ready")
  await coalesceResourceRequest("metadata", "report.html", "project-one", async () => { calls++; return "fresh" })
  expect(calls).toBe(2) // Later intent revalidates; a previous success is not authority.
  await coalesceResourceRequest("metadata", "report.html", "project-two", async () => { calls++; return "other" })
  expect(calls).toBe(3)
})

test("logout/session replacement fences an in-flight result and permits a fresh retry", async () => {
  setResourceSessionScope("session-before")
  let release!: (value: string) => void
  const previous = coalesceResourceRequest("register", "notes.md", "project", () => new Promise<string>(resolve => { release = resolve }))
  setResourceSessionScope(null)
  setResourceSessionScope("session-after")
  release("old private target")
  await expect(previous).rejects.toMatchObject({ name: "AbortError" })
  expect(await coalesceResourceRequest("register", "notes.md", "project", async () => "new target")).toBe("new target")
})

test("failed preparation is retryable rather than cached as a permanent failure", async () => {
  setResourceSessionScope("session-retry")
  await expect(coalesceResourceRequest("metadata", "file.txt", undefined, async () => { throw new Error("offline") })).rejects.toThrow("offline")
  expect(await coalesceResourceRequest("metadata", "file.txt", undefined, async () => "online")).toBe("online")
})
