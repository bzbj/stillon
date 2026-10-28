import { afterEach, expect, test } from "bun:test"
import { createWorkspaceSharingStore } from "./workspaceSharingStore"
import { SHARING_REFRESH_MS as TTL } from "../../shared/sharing-cache"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const view = (title: string) => ({ mode: "owner", configured: true, workspaces: [{ workspaceId: "sample", title, members: [] }] })

test("automatic readers share cached requests while management refreshes explicitly", async () => {
  let clock = 0, calls = 0
  const urls: string[] = []
  globalThis.fetch = (async url => { calls++; urls.push(String(url)); return Response.json(view(String(calls))) }) as typeof fetch
  const store = createWorkspaceSharingStore(() => clock)
  await Promise.all([store.getState().reload(), store.getState().reload()]); expect(calls).toBe(1)
  clock = TTL - 1; await store.getState().reload(); expect(calls).toBe(1)
  await store.getState().reload(true); expect(urls[1]).toEndWith("?refresh=1")
  clock += TTL; await store.getState().reload(); expect(calls).toBe(3)
})

test("failed refresh retains display metadata and backs off; manual refresh recovers", async () => {
  let clock = 0, calls = 0, offline = false
  globalThis.fetch = (async () => { calls++; return offline ? new Response("offline", { status: 503 }) : Response.json(view("saved")) }) as typeof fetch
  const store = createWorkspaceSharingStore(() => clock)
  await store.getState().reload(); clock += TTL; offline = true
  await expect(store.getState().reload()).rejects.toThrow()
  expect(store.getState().view?.workspaces[0]?.title).toBe("saved")
  await expect(store.getState().reload()).rejects.toThrow(); expect(calls).toBe(2)
  offline = false; await store.getState().reload(true); expect(calls).toBe(3)
})

test("mutation responses immediately replace cached metadata, not a delayed earlier GET", async () => {
  let resolve!: (value: Response) => void
  globalThis.fetch = (async (_url, options) => options?.method === "POST" ? Response.json(view("updated")) : new Promise<Response>(r => { resolve = r })) as typeof fetch
  const store = createWorkspaceSharingStore()
  const old = store.getState().reload(); await Promise.resolve()
  await store.getState().change({ operation: "stop", workspaceId: "sample" })
  resolve(Response.json(view("old"))); await old
  expect(store.getState().view?.workspaces[0]?.title).toBe("updated")
  await store.getState().reload(); expect(store.getState().view?.workspaces[0]?.title).toBe("updated")
})

test("changing auth scope clears metadata and rejects late results from the old account", async () => {
  let resolve!: (value: Response) => void
  globalThis.fetch = (async () => new Promise<Response>(r => { resolve = r })) as typeof fetch
  const store = createWorkspaceSharingStore()
  store.getState().setScope("first")
  const old = store.getState().reload(); await Promise.resolve()
  store.getState().setScope("second")
  resolve(Response.json(view("private"))); await old
  expect(store.getState().view).toBeNull()
})

test("another tab's invalidation does not discard a successful local mutation", async () => {
  let resolve!: (value: Response) => void
  globalThis.fetch = (async () => new Promise<Response>(r => { resolve = r })) as typeof fetch
  const store = createWorkspaceSharingStore()
  const pending = store.getState().change({ operation: "stop", workspaceId: "sample" })
  store.getState().invalidate()
  resolve(Response.json(view("updated"))); await pending
  expect(store.getState().view?.workspaces[0]?.title).toBe("updated")
})
