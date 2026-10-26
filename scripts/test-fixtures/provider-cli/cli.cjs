const fs = require("node:fs")
const path = require("node:path")
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"))
const version = fs.readFileSync(fixture.version, "utf8").trim()
if (process.argv.includes("--version")) { console.log("codex-cli " + version); process.exit(0) }
if (fixture.provider === "claude" && process.argv[2] === "install" && /^\d+\.\d+\.\d+$/.test(process.argv[3])) {
  if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(7)
  fs.writeFileSync(fixture.version, process.argv[3]); process.exit(0)
}
if (!process.argv.includes("app-server")) process.exit(2)
let initialized = false
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line)
  let result
  if (message.method === "initialize") {
    result = { userAgent: "codex-cli/" + (fs.existsSync(fixture.serverVersion) ? fs.readFileSync(fixture.serverVersion, "utf8").trim() : version) }
  } else if (message.method === "initialized") { initialized = true; return }
  else if (message.method === "model/list" && initialized) {
    result = { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture Model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }
  } else { process.exit(3); return }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n")
})
