const fs = require("node:fs")
const path = require("node:path")
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"))
const args = process.argv.slice(2)
if (args[0] !== "install" || args[1] !== "--global" || args[2] !== "--prefix"
  || fs.realpathSync.native(args[3]) !== fs.realpathSync.native(fixture.root)) process.exit(4)
const expected = fixture.packageName + "@"
if (!args[4]?.startsWith(expected)) process.exit(6)
const target = args[4].slice(expected.length)
if (!/^\d+\.\d+\.\d+$/.test(target)) process.exit(6)
fs.appendFileSync(fixture.calls, "install\n")
if (fs.existsSync(fixture.interrupted)) {
  fs.unlinkSync(fixture.interrupted)
  fs.unlinkSync(fixture.executable); fs.unlinkSync(fixture.manifest)
  fs.writeFileSync(fixture.retired, "ready")
  setInterval(() => {}, 1000)
} else {
  // Only the interruption scenario restores retired files. Ordinary missing
  // shims still exercise the bounded failure path rather than being repaired.
  if (fs.existsSync(fixture.retired)) {
    fs.writeFileSync(fixture.manifest, JSON.stringify({ name: fixture.packageName, bin: { [fixture.provider]: "cli.js" } }))
    if (process.platform === "win32") fs.copyFileSync(fixture.launcherBackup, fixture.executable)
    else fs.symlinkSync(fixture.cli, fixture.executable)
    fs.unlinkSync(fixture.retired)
  }
  if (fs.existsSync(fixture.failure)) process.exit(5)
  setTimeout(() => fs.writeFileSync(fixture.version, target), 750)
}
