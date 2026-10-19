import { afterEach, expect, test } from "bun:test"
import { executeResourceAction } from "../components/ResourceLink"
import { preparePreviewEntry, registerResourceTarget } from "./previewTarget"
import { setResourceSessionScope } from "./resourceRequests"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; setResourceSessionScope(null) })

const address = "/api/projects/example/preview/report.html"
const target = { kind: "project-file", address, projectId: "example", filePath: "report.html" }

test("opening a prepared HTML target reuses registration metadata without another registration or GET", async () => {
  setResourceSessionScope("prepared-html")
  const requests: string[] = []
  globalThis.fetch = (async (input) => {
    requests.push(String(input))
    return Response.json({ url: "/preview/example-target", target, renderer: "html" })
  }) as typeof fetch
  await registerResourceTarget(address, "example")
  expect(await preparePreviewEntry(address, "example")).toMatchObject({ id: "example-target", address, target })
  expect(requests).toEqual(["/api/preview-targets"])
})

test("older registration responses still resolve metadata through an authorized GET", async () => {
  setResourceSessionScope("legacy-host")
  const requests: string[] = []
  globalThis.fetch = (async (input) => {
    requests.push(String(input))
    return Response.json(requests.length === 1 ? { url: "/preview/legacy-target" } : { target, projectId: "example" })
  }) as typeof fetch
  expect(await preparePreviewEntry(address, "example")).toMatchObject({ id: "legacy-target", target })
  expect(requests).toEqual(["/api/preview-targets", "/api/preview-targets/legacy-target"])
})

test("a prepared default action uses its existing registration and the server still authorizes the action", async () => {
  setResourceSessionScope("prepared-action")
  const requests: string[] = []
  globalThis.fetch = (async (input) => {
    requests.push(String(input))
    return Response.json({ error: "This action is available only on the computer itself." }, { status: 403 })
  }) as typeof fetch
  await expect(executeResourceAction(address, "open_default", "example", undefined, "/preview/prepared-target")).rejects.toThrow("only on the computer")
  expect(requests).toEqual(["/api/preview-targets/prepared-target/action"])
})

test("cancelling while registration is pending prevents the subsequent host action", async () => {
  setResourceSessionScope("cancel-action")
  const controller = new AbortController(), requests: string[] = []
  let release!: (value: Response) => void
  globalThis.fetch = ((input) => {
    requests.push(String(input))
    return new Promise<Response>(resolve => { release = resolve })
  }) as typeof fetch
  const action = executeResourceAction(address, "open_default", "example", controller.signal)
  controller.abort()
  release(Response.json({ url: "/preview/cancelled-target", target }))
  await expect(action).rejects.toMatchObject({ name: "AbortError" })
  expect(requests).toEqual(["/api/preview-targets"])
})
