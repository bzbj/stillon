import { writeFile } from "node:fs/promises"
import { createConnectFixture } from "./connect-fixture"

// An isolated browser fixture, with an in-memory fake sender only. It never
// reads production mail settings or sends mail to a real address.
for (const key of Object.keys(process.env)) if (key.startsWith("STILLON_UPDATE_") || key === "STILLON_RUNTIME_PROFILE") delete process.env[key]
const fixture = await createConnectFixture()
const info = { origin: fixture.origin, root: fixture.root, hosts: fixture.hosts.map(host => `http://127.0.0.1:${host.port}`) }
await writeFile("test-artifacts/connect/browser-fixture.json", JSON.stringify(info), { mode: 0o600 })
let count = 0
const timer = setInterval(() => {
  if (fixture.messages.length === count) return
  count = fixture.messages.length
  void writeFile("test-artifacts/connect/browser-mail.json", JSON.stringify(fixture.messages), { mode: 0o600 })
}, 100)
console.log(JSON.stringify(info))
await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
clearInterval(timer)
await fixture.stop()
