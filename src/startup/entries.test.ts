import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { startConnectServer } from "../connect/server"
import { serveStaticAsset } from "../server/static-assets"

function controllerUrl(html: string) {
  const match = html.match(/<script src="(\/assets\/startup-[a-f0-9]{12}\.js)"><\/script>/)
  expect(match).not.toBeNull()
  return match![1]!
}

test("built local host serves critical HTML and its independent controller with correct MIME", async () => {
  const dist = path.resolve("dist/client")
  const index = await serveStaticAsset(dist, new Request("http://127.0.0.1/"), "/")
  expect(index?.status).toBe(200)
  const html = await index!.text()
  expect(html).toContain('id="stillon-startup" data-mode="host"')
  expect(html).toContain('media="print" data-stillon-styles')
  expect(html).toMatch(/rel="modulepreload"[^>]+href="\/assets\/workspace-[a-f0-9]{12}\.js"/)
  const url = controllerUrl(html)
  const controller = await serveStaticAsset(dist, new Request(`http://127.0.0.1${url}`), url)
  expect(controller?.status).toBe(200)
  expect(controller?.headers.get("content-type")).toContain("javascript")
  expect(await controller!.text()).toContain("window.StillOnStartup")
})

test("Connect authorize serves the same shell/controller under the unchanged self-only script CSP", async () => {
  const base = path.resolve("test-artifacts/startup")
  await mkdir(base, { recursive: true })
  const dataDir = await mkdtemp(path.join(base, "portal-"))
  const server = await startConnectServer({
    origin: "http://127.0.0.1", port: 0, dataDir, secret: randomBytes(32).toString("hex"),
    sender: { async send() { throw new Error("Mail is not used by this entry check") } },
  })
  try {
    const request = (url: string) => fetch(`http://127.0.0.1:${server.port}${url}`, { headers: { Host: "127.0.0.1" } })
    const response = await request("/authorize?flow=example")
    expect(response.status).toBe(200)
    const csp = response.headers.get("content-security-policy")!
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    const html = await response.text()
    expect(html).toContain('id="stillon-startup" data-mode="portal"')
    const controller = await request(controllerUrl(html))
    expect(controller.status).toBe(200)
    expect(controller.headers.get("content-type")).toContain("javascript")
    expect(await controller.text()).toContain("window.StillOnStartup")
    const health = await request("/health")
    expect(await health.json()).toEqual({ ok: true })
  } finally {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
