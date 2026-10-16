import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { startConnectServer } from "../src/connect/server"
import { startStillOnServer } from "../src/server/server"
import { randomToken } from "../src/server/connect/crypto"
import type { LoginEmail } from "../src/connect/mail"

export function freePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; void server.stop(true); return port }
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const until = Date.now() + timeout
  let result: T
  while (Date.now() < until) { try { result = await read(); if (accept(result)) return result } catch { /* retry startup */ } await Bun.sleep(200) }
  throw new Error("Timed out waiting for isolated Connect fixture")
}
export async function createConnectFixture(count = 2, startCloud: typeof startConnectServer = startConnectServer) {
  await mkdir("test-artifacts/connect", { recursive: true })
  const root = await mkdtemp(path.resolve("test-artifacts/connect/transport-"))
  const binaries = path.resolve("runtime/frp")
  const executable = (name: string) => path.join(binaries, `${name}${process.platform === "win32" ? ".exe" : ""}`)
  if (!await Bun.file(executable("frps")).exists()) throw new Error("Run bun run prepare:connect-runtime --server first")
  const bind = freePort(), vhost = freePort(), port = freePort()
  const origin = `http://localhost:${port}`
  const messages: LoginEmail[] = []
  const hosts: Awaited<ReturnType<typeof startStillOnServer>>[] = []
  const service = await startCloud({ port, origin, dataDir: path.join(root, "cloud"), secret: randomToken(),
    sender: { async send(message) { messages.push(message) } }, remote: { upstreamOrigin: `http://127.0.0.1:${vhost}`, pluginPort: 0, tunnelOrigin: `http://127.0.0.1:${bind}` } })
  const config = path.join(root, "frps.json")
  await writeFile(config, JSON.stringify({ bindAddr: "127.0.0.1", bindPort: bind, proxyBindAddr: "127.0.0.1", vhostHTTPPort: vhost, log: { level: "error" },
    httpPlugins: [{ name: "connect", addr: `127.0.0.1:${service.pluginPort}`, path: "/plugin", ops: ["Login", "NewProxy", "Ping", "NewWorkConn"] }] }))
  const child = Bun.spawn([executable("frps"), "-c", config], { stdout: "ignore", stderr: "ignore" })
  async function stop() {
    await Promise.allSettled(hosts.map(host => host.stop()))
    if (child.exitCode === null) { child.kill(); await Promise.race([child.exited, Bun.sleep(1_000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited } }
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
  try {
    await eventually(() => fetch(`http://127.0.0.1:${bind}/~!frp`), () => true)
    for (let i = 0; i < count; i++) {
      const dataDir = path.join(root, `computer-${i + 1}`)
      await mkdir(dataDir, { recursive: true })
      await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ machineName: `Test computer ${i + 1}` }))
      const server = await startStillOnServer({ dataDir, port: 0, strictPort: true, discoveryHome: root,
        connect: { origin, frpcPath: executable("frpc") }, codexModelDiscovery: { discover: async () => { throw new Error("Disabled in isolated fixture") } } })
      hosts.push(server)
      const project = path.join(root, `workspace-${i + 1}`)
      await mkdir(project, { recursive: true })
      await writeFile(path.join(project, "report.txt"), `Workspace ${i + 1} report`)
      await writeFile(path.join(project, "report.html"), '<!doctype html><h1>Example report</h1><script>document.body.dataset.executed="yes"</script>')
      await server.store.openProject(project, `Workspace ${i + 1}`)
    }
  } catch (error) { await stop(); throw error }
  return { root, origin, port, service, hosts, messages, stop }
}
