import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

export const FRP_VERSION = "0.71.1"
const checksums: Record<string, string> = {
  darwin_amd64: "8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45",
  darwin_arm64: "d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842",
  linux_amd64: "1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803",
  linux_arm64: "8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019",
  windows_amd64: "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821",
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export async function prepareConnectRuntime(output: string, target = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`, includeServer = false) {
  const checksum = checksums[target]
  if (!checksum) throw new Error(`Connect transport is not packaged for ${target}`)
  await mkdir(output, { recursive: true })
  const temp = await mkdtemp(path.join(output, ".download-"))
  const name = `frp_${FRP_VERSION}_${target}`
  const filename = `${name}.${target.startsWith("windows_") ? "zip" : "tar.gz"}`
  try {
    const response = await fetch(`https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${filename}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Transport download failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (digest(bytes) !== checksum) throw new Error("Transport archive checksum mismatch")
    const archive = path.join(temp, filename)
    await writeFile(archive, bytes)
    const suffix = target.startsWith("windows_") ? ".exe" : ""
    const files = [`frpc${suffix}`, ...(includeServer ? [`frps${suffix}`] : []), "LICENSE"]
    const child = Bun.spawn(["tar", "-xf", archive, "-C", temp, ...files.map(file => `${name}/${file}`)], { stdout: "ignore", stderr: "inherit" })
    if (await child.exited !== 0) throw new Error("Unable to extract transport")
    const hashes: Record<string, string> = {}
    for (const file of files) {
      const destination = path.join(output, file)
      await copyFile(path.join(temp, name, file), destination)
      if (file !== "LICENSE") await chmod(destination, 0o755)
      hashes[file] = digest(await readFile(destination))
    }
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: FRP_VERSION, target, archiveSha256: checksum, files: hashes }, null, 2) + "\n")
  } finally { await rm(temp, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (key: string) => args.find(arg => arg.startsWith(`${key}=`))?.slice(key.length + 1)
  const output = path.resolve(value("--output") ?? "runtime/frp")
  await prepareConnectRuntime(output, value("--target"), args.includes("--server"))
  console.log("Verified Connect transport prepared.")
}
