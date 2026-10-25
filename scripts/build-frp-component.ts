import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import components from "../src/server/connect/frp-components.json"
import { FRP_VERSION, readTransportArchive, transportBinary, transportHash, validateTransportComponent, type TransportComponent } from "../src/server/connect/transport-component"
import { downloadTransport } from "../src/server/connect/transport-component"

/** Run separately from StillOn releases; never re-sign a component on an app build. */
async function main() {
  const value = (name: string) => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  const base = value("--download-base")
  const baseUrl = base ? new URL(base) : null
  if (!baseUrl || baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("Supply the immutable HTTPS component release URL with --download-base=…")
  const source = validateTransportComponent(components.find(c => c.platform === process.platform && c.architecture === process.arch))
  const output = path.resolve(value("--output") ?? "dist/connect-components")
  await mkdir(output, { recursive: true })
  const temp = await mkdtemp(path.join(os.tmpdir(), "stillon-connect-component-"))
  async function run(args: string[]) {
    const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" })
    if (await child.exited !== 0) throw new Error(`Component build failed: ${path.basename(args[0])}`)
  }
  try {
    const verified = await readTransportArchive(await downloadTransport(source), source)
    const directory = path.join(temp, "component"), name = transportBinary(source)
    await mkdir(directory)
    const file = path.join(directory, name)
    await writeFile(file, verified.binary, { mode: 0o755 }); await chmod(file, 0o755)
    await writeFile(path.join(directory, "LICENSE"), verified.license)
    let signing: TransportComponent["signing"] = "unsigned"
    if (process.env.STILLON_REQUIRE_SIGNING === "1") {
      if (process.platform === "darwin") {
        if (!process.env.MACOS_SIGN_IDENTITY || !process.env.MACOS_NOTARY_PROFILE) throw new Error("Configure the Developer ID identity and notary profile before signing components")
        await run(["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", process.env.MACOS_SIGN_IDENTITY, file])
        await run(["/usr/bin/codesign", "--verify", "--strict", file])
        signing = "developer-id"
      } else if (process.platform === "win32") {
        if (!process.env.WINDOWS_SIGN_SCRIPT) throw new Error("Configure WINDOWS_SIGN_SCRIPT before signing components")
        await run(["pwsh", "-NoProfile", "-NonInteractive", "-File", path.resolve(process.env.WINDOWS_SIGN_SCRIPT), file])
        signing = "authenticode"
      } else throw new Error("Public component signing supports Windows and macOS")
    }
    const binary = await readFile(file), binaryHash = transportHash(binary)
    // A ZIP is a supported Apple notarization container. Its helper keeps its
    // own Developer ID signature and online notarization ticket after extraction.
    const format = signing === "developer-id" ? "zip" : "tar.gz"
    const filename = `stillon-frpc-${FRP_VERSION}-${source.platform}-${source.architecture}-${binaryHash.slice(0, 16)}.${format}`
    const archive = path.join(output, filename)
    if (await Bun.file(archive).exists()) throw new Error("Refusing to replace an existing component artifact")
    if (format === "zip") {
      await run(["/usr/bin/ditto", "-c", "-k", directory, archive])
      await run(["/usr/bin/xcrun", "notarytool", "submit", archive, "--keychain-profile", process.env.MACOS_NOTARY_PROFILE!,
        ...(process.env.MACOS_NOTARY_KEYCHAIN ? ["--keychain", process.env.MACOS_NOTARY_KEYCHAIN] : []), "--wait"])
    } else {
      const bytes = await new Bun.Archive({ [name]: binary, LICENSE: verified.license }, { compress: "gzip" }).bytes()
      await writeFile(archive, bytes, { flag: "wx" })
    }
    const result: TransportComponent = { schema: 1, version: FRP_VERSION, platform: source.platform, architecture: source.architecture,
      archive: { url: `${baseUrl.href.replace(/\/$/, "")}/${filename}`, format, prefix: "", sha256: transportHash(await readFile(archive)) },
      executable: { sha256: binaryHash, size: binary.length }, signing }
    validateTransportComponent(result)
    await readTransportArchive(await readFile(archive), result)
    await writeFile(path.join(output, `component-${source.platform}-${source.architecture}.json`), JSON.stringify([result], null, 2) + "\n")
    console.log(`Connect component verified: ${filename} (${signing}). Publish once, then pin its descriptor for subsequent StillOn builds.`)
  } finally { await rm(temp, { recursive: true, force: true }) }
}

if (import.meta.main) await main()
