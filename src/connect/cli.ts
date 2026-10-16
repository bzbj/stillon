import path from "node:path"
import { createResendSender } from "./mail"
import { startConnectServer } from "./server"

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Configure ${name} before starting Connect`)
  return value
}

try {
  const port = Number(process.env.STILLON_CONNECT_PORT ?? 3220)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid STILLON_CONNECT_PORT")
  const pluginPort = Number(process.env.STILLON_CONNECT_FRP_PLUGIN_PORT ?? 3221)
  if (!Number.isInteger(pluginPort) || pluginPort < 1 || pluginPort > 65_535) throw new Error("Invalid STILLON_CONNECT_FRP_PLUGIN_PORT")
  const trustProxy = process.env.STILLON_CONNECT_TRUST_PROXY ?? "false"
  if (!["true", "false"].includes(trustProxy)) throw new Error("STILLON_CONNECT_TRUST_PROXY must be true or false")
  const app = await startConnectServer({
    origin: required("STILLON_CONNECT_ORIGIN"),
    secret: required("STILLON_CONNECT_SECRET"),
    dataDir: path.resolve(process.env.STILLON_CONNECT_DATA_DIR ?? ".stillon-connect"),
    sender: createResendSender({
      apiKey: required("STILLON_CONNECT_RESEND_API_KEY"),
      from: required("STILLON_CONNECT_EMAIL_FROM"),
    }),
    port,
    trustProxy: trustProxy === "true",
    ...(process.env.STILLON_CONNECT_FRP_UPSTREAM ? { remote: {
      upstreamOrigin: process.env.STILLON_CONNECT_FRP_UPSTREAM,
      tunnelOrigin: process.env.STILLON_CONNECT_TUNNEL_ORIGIN,
      pluginPort,
    } } : {}),
  })
  console.log(`StillOn Connect listening on 127.0.0.1:${app.port}`)
  let stopping = false
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      void app.stop().then(() => process.exit(0))
    })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to start Connect")
  process.exitCode = 1
}
