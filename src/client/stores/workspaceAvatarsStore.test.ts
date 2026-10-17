import { afterEach, describe, expect, test } from "bun:test"
import { defaultWorkspaceAvatars } from "../../shared/workspace-avatars"
import { useWorkspaceAvatarsStore } from "./workspaceAvatarsStore"

const originalFetch = globalThis.fetch
const initialState = useWorkspaceAvatarsStore.getInitialState()

afterEach(() => {
  globalThis.fetch = originalFetch
  useWorkspaceAvatarsStore.setState(initialState, true)
})

describe("workspace avatar responses", () => {
  test("a plain-text denial keeps saved choices and allows an explicit retry", async () => {
    const config = defaultWorkspaceAvatars()
    config.workspaces.sample = { shape: "round", color: "#112233" }
    useWorkspaceAvatarsStore.setState({ config })
    const choice = { shape: "pebble", color: "#3d7ff5" }
    let attempts = 0
    globalThis.fetch = (async (_url, options) => {
      attempts++
      if (attempts === 1) return new Response("Forbidden", { status: 403 })
      expect(JSON.parse(String(options?.body))).toEqual({ workspaceId: "sample", ...choice })
      return Response.json({ config: { ...config, workspaces: { ...config.workspaces, sample: choice } } })
    }) as typeof fetch

    await expect(useWorkspaceAvatarsStore.getState().save("sample", choice)).rejects.toThrow(/blocked.*403/i)
    expect(useWorkspaceAvatarsStore.getState().config).toEqual(config)
    expect(attempts).toBe(1)
    await useWorkspaceAvatarsStore.getState().save("sample", choice)
    expect(useWorkspaceAvatarsStore.getState().config.workspaces.sample).toEqual(choice)
    expect(attempts).toBe(2)
  })

  test("expired sessions and non-JSON server failures report actionable errors", async () => {
    for (const [status, body, message] of [
      [401, "Unauthorized", /sign in again/i],
      [503, "<html>Service unavailable</html>", /503/],
    ] as const) {
      globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch
      await expect(useWorkspaceAvatarsStore.getState().save("sample", { shape: "round", color: "#112233" })).rejects.toThrow(message)
    }
  })

  test("JSON validation errors survive and malformed success responses do not replace state", async () => {
    const before = useWorkspaceAvatarsStore.getState().config
    globalThis.fetch = (async () => Response.json({ error: "Workspace not found." }, { status: 404 })) as typeof fetch
    await expect(useWorkspaceAvatarsStore.getState().save("sample", { shape: "round", color: "#112233" })).rejects.toThrow("Workspace not found.")
    globalThis.fetch = (async () => new Response("not JSON")) as typeof fetch
    await expect(useWorkspaceAvatarsStore.getState().save("sample", { shape: "round", color: "#112233" })).rejects.toThrow(/invalid response/i)
    expect(useWorkspaceAvatarsStore.getState().config).toEqual(before)
  })

  test("reload retains the last good avatar configuration on a non-JSON denial", async () => {
    const before = useWorkspaceAvatarsStore.getState().config
    globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch
    await useWorkspaceAvatarsStore.getState().reload()
    expect(useWorkspaceAvatarsStore.getState().error).toMatch(/blocked.*403/i)
    expect(useWorkspaceAvatarsStore.getState().config).toEqual(before)
  })
})
