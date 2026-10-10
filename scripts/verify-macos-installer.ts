import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyBundle } from "../src/server/distribution/bundle"
import { updateTarget } from "../src/server/updater/model"

if (process.platform !== "darwin") throw new Error("DMG acceptance requires macOS")
const images = await Array.fromAsync(new Bun.Glob("*.dmg").scan("dist/desktop/release"))
if (images.length !== 1) throw new Error("Expected one macOS installer")
const root = await mkdtemp(path.join(os.tmpdir(), "stillon-dmg-acceptance-"))
const mount = path.join(root, "mounted")
let attached = false
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${path.basename(command[0])}: ${stderr}`)
  return stdout
}
try {
  await mkdir(mount)
  await run(["/usr/bin/hdiutil", "attach", path.resolve("dist/desktop/release", images[0]), "-readonly", "-nobrowse", "-mountpoint", mount])
  attached = true
  const app = path.join(root, "Applications with spaces", "StillOn.app")
  await cp(path.join(mount, "StillOn.app"), app, { recursive: true })
  const plist = path.join(app, "Contents/Info.plist")
  if ((await run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleExecutable", plist])).trim() !== "StillOn") throw new Error("Invalid app entrypoint")
  const architecture = (await run(["/usr/bin/lipo", "-archs", path.join(app, "Contents/MacOS/StillOn")])).trim()
  if (architecture !== (process.arch === "x64" ? "x86_64" : "arm64")) throw new Error("Launcher architecture mismatch")
  const payload = path.join(app, "Contents/Resources/payload")
  const bundle = await verifyBundle(payload, updateTarget())
  if ((await run([path.join(payload, "runtime/bun"), "--no-env-file", path.join(payload, "bin/stillon"), "--version"])).trim() !== bundle.version) throw new Error("Installed app CLI mismatch")
  await mkdir("dist/desktop/reports", { recursive: true })
  await writeFile("dist/desktop/reports/macos-installer.json", JSON.stringify({ status: "passed", architecture,
    checks: ["read-only DMG mount", "app copy to path with spaces", "app metadata and native launcher architecture", "installed payload integrity and bundled CLI"] }, null, 2) + "\n")
} finally {
  if (attached) await run(["/usr/bin/hdiutil", "detach", mount])
  await rm(root, { recursive: true, force: true })
}
