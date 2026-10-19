import { afterEach, expect, test } from "bun:test"
import type { ProjectGitSnapshotData } from "../../shared/types"
import type { SubscriptionTopic } from "../../shared/protocol"
import { subscribeProjectGit } from "./projectGitSubscription"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const turn = () => new Promise(resolve => setTimeout(resolve, 0))
function socket() {
  let topic: SubscriptionTopic | undefined
  let listener: (data: ProjectGitSnapshotData) => void = () => {}
  let unsubscribed = false
  return {
    get topic() { return topic },
    get unsubscribed() { return unsubscribed },
    emit(data: ProjectGitSnapshotData) { listener(data) },
    subscribe<T>(next: SubscriptionTopic, receive: (data: T) => void) {
      topic = next
      listener = receive as typeof listener
      return () => { unsubscribed = true }
    },
  }
}

test("small and legacy snapshots arrive directly without an HTTP request", () => {
  const source = socket(), received: ProjectGitSnapshotData[] = []
  globalThis.fetch = (() => { throw new Error("Unexpected HTTP read") }) as typeof fetch
  const stop = subscribeProjectGit(source, "workspace", value => received.push(value))
  expect(source.topic).toEqual({ type: "project-git", projectId: "workspace", deferLargeSnapshots: true })
  const snapshot = { status: "ready" as const, files: [] }
  source.emit(snapshot)
  source.emit(null)
  expect(received).toEqual([snapshot, null])
  stop()
  expect(source.unsubscribed).toBe(true)
})

test("deferred snapshots use an uncached HTTP read and reject stale or unsubscribed replies", async () => {
  const source = socket(), received: ProjectGitSnapshotData[] = []
  const requests: Array<{ url: string; options?: RequestInit; resolve: (response: Response) => void }> = []
  globalThis.fetch = ((url, options) => new Promise<Response>(resolve => requests.push({ url: String(url), options, resolve }))) as typeof fetch
  const stop = subscribeProjectGit(source, "workspace with spaces", value => received.push(value))
  source.emit({ deferred: true, revision: "one" })
  expect(requests[0]!.url).toBe("/api/projects/workspace%20with%20spaces/git-snapshot")
  expect(requests[0]!.options?.cache).toBe("no-store")
  source.emit({ deferred: true, revision: "two" })
  expect(requests[0]!.options?.signal?.aborted).toBe(true)
  requests[0]!.resolve(Response.json({ status: "ready", files: [], branchName: "stale" }))
  requests[1]!.resolve(Response.json({ status: "ready", files: [], branchName: "current" }))
  await turn()
  expect(received).toEqual([{ status: "ready", files: [], branchName: "current" }])
  source.emit({ deferred: true, revision: "three" })
  stop()
  expect(requests[2]!.options?.signal?.aborted).toBe(true)
  requests[2]!.resolve(Response.json({ status: "ready", files: [], branchName: "disposed" }))
  await turn()
  expect(received).toHaveLength(1)
})

test("failed HTTP reads preserve the last visible Git data", async () => {
  const source = socket(), received: ProjectGitSnapshotData[] = []
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch
  const stop = subscribeProjectGit(source, "workspace", value => received.push(value))
  source.emit({ status: "ready", files: [], branchName: "saved" })
  source.emit({ deferred: true, revision: "new" })
  await turn()
  expect(received).toEqual([{ status: "ready", files: [], branchName: "saved" }])
  stop()
})
