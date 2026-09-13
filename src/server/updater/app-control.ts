import { timingSafeEqual } from "node:crypto"

export function createManagedAppControl(options: {
  instance?: string
  secret?: string
  verifying?: boolean
  busy: () => boolean
  shutdown: () => Promise<void>
}) {
  let paused = Boolean(options.instance && options.secret && options.verifying)
  return {
    get paused() { return paused },
    get instance() { return options.instance && options.secret ? options.instance : undefined },
    handle(request: Request, address: string | undefined): Response | null {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/_stillon/update/")) return null
      const authorization = Buffer.from(request.headers.get("authorization") ?? "")
      const expected = Buffer.from(`Bearer ${options.secret ?? ""}`)
      if (!options.secret || !options.instance || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")
        || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        return new Response(null, { status: 403 })
      }
      if (request.method !== "POST") return new Response(null, { status: 405 })
      if (pathname === "/_stillon/update/check") return Response.json({ busy: options.busy() }, { status: options.busy() ? 409 : 200 })
      if (pathname === "/_stillon/update/resume") { paused = false; return Response.json({ ok: true }) }
      if (pathname !== "/_stillon/update/pause") return new Response(null, { status: 404 })
      if (options.busy()) return Response.json({ error: "Active work must finish before updating." }, { status: 409 })
      paused = true
      // Respond before closing the listener, so the controller can verify consent.
      setTimeout(() => { void options.shutdown() }, 0)
      return Response.json({ ok: true })
    },
  }
}
