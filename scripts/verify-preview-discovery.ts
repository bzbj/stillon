import assert from "node:assert/strict"
import { listLocalHttpServers } from "../src/server/local-http-servers"

const scans = Number(process.argv.find(value => value.startsWith("--scans="))?.slice(8) ?? 30)
assert(Number.isInteger(scans) && scans > 0 && scans <= 100)
const apps = (["127.0.0.1", "::1"] as const).map(hostname => Bun.serve({ hostname, port: 0,
  fetch: () => new Response("<title>Stable discovery fixture</title>", { headers: { "Content-Type": "text/html" } }),
}))
const checks: { iteration: number; ipv4: boolean; ipv6: boolean; elapsedMs: number }[] = []
try {
  for (let index = 0; index < scans; index++) {
    const started = performance.now()
    // Distinct keys exercise actual discovery, rather than repeatedly reading a cache.
    const services = await listLocalHttpServers({ projectPath: "discovery-regression-" + apps[0]!.port + "-" + index })
    checks.push({ iteration: index + 1, ipv4: services.some(value => value.port === apps[0]!.port),
      ipv6: services.some(value => value.port === apps[1]!.port), elapsedMs: Math.round(performance.now() - started) })
  }
  const result = { platform: process.platform, scans, checks }
  await Bun.write("test-artifacts/preview-discovery-results.json", JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  assert(checks.every(value => value.ipv4 && value.ipv6), "Every fresh scan must find both healthy listeners")
} finally { for (const app of apps) await app.stop(true) }
