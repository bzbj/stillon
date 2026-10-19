import path from "node:path"
import { pathToFileURL } from "node:url"
import type { startStillOnServer } from "../src/server/server"

/** Public test contract; the hosted implementation is supplied by its owner. */
export interface ConnectTestFixture {
  origin: string
  hosts: Awaited<ReturnType<typeof startStillOnServer>>[]
  messages: { code: string }[]
  stop(): Promise<void>
}

export function freePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; void server.stop(true); return port }
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const until = Date.now() + timeout
  let result: T
  while (Date.now() < until) { try { result = await read(); if (accept(result)) return result } catch { /* Retry isolated fixture startup. */ } await Bun.sleep(200) }
  throw new Error("Timed out waiting for isolated test fixture")
}

/** Explicit CLI injection keeps public builds independent of private access. */
export async function createConnectFixture(count = 2): Promise<ConnectTestFixture> {
  const source = process.argv.find(value => value.startsWith("--connect-fixture-module="))?.slice("--connect-fixture-module=".length)
  if (!source) throw new Error("Managed integration needs an explicit --connect-fixture-module; use --local-only for public checks")
  const module = await import(pathToFileURL(path.resolve(source)).href)
  if (typeof module.createConnectFixture !== "function") throw new Error("Invalid managed test fixture module")
  return module.createConnectFixture(count)
}
