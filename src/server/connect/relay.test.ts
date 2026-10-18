import { expect, test } from "bun:test"
import path from "node:path"

test("native relay survives client cancellations, streams incrementally and revokes active bodies", async () => {
  // Isolate native runtime failures: a Bun socket abort must fail this test,
  // rather than crash the entire repository test runner.
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../test-fixtures/connect-relay-aborts.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  })
  const diagnostics = new Response(child.stderr).text()
  const deadline = setTimeout(() => { if (child.exitCode === null) child.kill() }, 20_000)
  deadline.unref()
  try {
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    let ready = ""
    while (!ready.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Relay fixture exited before readiness: " + await diagnostics)
      ready += decoder.decode(chunk.value, { stream: true })
    }
    reader.releaseLock()
    const { origin } = JSON.parse(ready) as { origin: string }
    let completed = 0, aborted = 0
    await Promise.all(Array.from({ length: 20 }, async () => {
      for (let i = 0; i < 30; i++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), i % 10)
        try { await (await fetch(origin, { signal: controller.signal })).arrayBuffer(); completed++ }
        catch { aborted++ }
        finally { clearTimeout(timer) }
      }
    }))
    expect(completed + aborted).toBe(600)
    expect(aborted).toBeGreaterThan(0)
    expect(child.exitCode, "The relay process must remain alive after native client aborts").toBeNull()
    const response = await fetch(origin, { signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(4096).fill(71))
    const large = await fetch(origin + "/large", { signal: AbortSignal.timeout(5000) })
    expect(new Uint8Array(await large.arrayBuffer())).toEqual(new Uint8Array(256 * 4096).fill(71))
    expect(await (await fetch(origin + "/state")).json()).toEqual({ active: 0 })
    const streaming = await fetch(origin + "/long", { signal: AbortSignal.timeout(5000) })
    const body = streaming.body!.getReader(), first = await body.read()
    expect(first.done).toBe(false)
    let received = first.value!.byteLength
    const revokedAt = Date.now()
    await fetch(origin + "/revoke")
    try {
      while (true) { const chunk = await body.read(); if (chunk.done) break; received += chunk.value.byteLength }
    } catch { /* Revocation can fail an already-started HTTP body. */ }
    body.releaseLock()
    expect(received).toBeLessThan(100 * 4096)
    expect(Date.now() - revokedAt).toBeLessThan(1500)
    expect(await (await fetch(origin + "/state")).json()).toEqual({ active: 0 })
    child.stdin.end()
    expect(await child.exited, await diagnostics).toBe(0)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
}, 25_000)
