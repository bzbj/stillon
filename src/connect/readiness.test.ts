import { expect, test } from "bun:test"
import { createReadinessProbe } from "./readiness"

test("readiness coalesces dependency probes and recovers after storage or relay failure", async () => {
  let now = 1, storage = true, status = 404, requests = 0
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++; expect(request.method).toBe("HEAD"); expect(request.headers.get("host")).toBe("readiness.invalid")
    return new Response(null, { status })
  } })
  const check = createReadinessProbe(() => { if (!storage) throw new Error("private storage details") }, `http://127.0.0.1:${upstream.port}`, () => now)
  try {
    expect(await Promise.all([check(), check(), check()])).toEqual([true, true, true])
    expect(requests).toBe(1)
    now += 5_001; storage = false
    expect(await check()).toBe(false); expect(requests).toBe(1)
    now += 5_001; storage = true; status = 503
    expect(await check()).toBe(false)
    now += 5_001; status = 404
    expect(await check()).toBe(true)
    await upstream.stop(true); now += 5_001
    expect(await check()).toBe(false)
  } finally { await upstream.stop(true) }
})

test("readiness never follows a dependency redirect", async () => {
  let destinationRequests = 0
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationRequests++; return new Response() } })
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`http://127.0.0.1:${destination.port}`) } })
  try {
    expect(await createReadinessProbe(() => {}, `http://127.0.0.1:${redirect.port}`)()).toBe(false)
    expect(destinationRequests).toBe(0)
  } finally { await redirect.stop(true); await destination.stop(true) }
})
