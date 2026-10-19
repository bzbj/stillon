import { createHash } from "node:crypto"
import { lstat, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { isGeneratedBuildAssetPath } from "../shared/public-asset-cache"

const MANIFEST = "public-build-assets.json"
type Representation = { sha256: string; bytes: number }
interface Manifest { version: 1; build: string; assets: Record<string, Representation> }
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** The allowlist comes from Vite's generated bundle, never a directory scan. */
export async function writePublicBuildManifest(directory: string, generatedPaths: string[]) {
  const assets: Manifest["assets"] = {}
  for (const name of [...new Set(generatedPaths)].sort()) {
    if (!isGeneratedBuildAssetPath(name)) continue
    for (const suffix of ["", ".br", ".gz"]) {
      try {
        const bytes = await readFile(path.join(directory, name + suffix))
        assets[name + suffix] = { sha256: digest(bytes), bytes: bytes.length }
      } catch (error) {
        if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
    }
  }
  const manifest: Manifest = { version: 1, build: digest(JSON.stringify(assets)), assets }
  await writeFile(path.join(directory, MANIFEST), JSON.stringify(manifest))
  return manifest
}

const manifests = new Map<string, { stamp: string; manifest: Manifest; verified: Map<string, string> }>()
export async function publicBuildAssetProof(directory: string, relativePath: string, encoding: "br" | "gzip" | "identity") {
  if (!isGeneratedBuildAssetPath(relativePath)) return null
  try {
    const file = path.join(directory, MANIFEST), stat = await lstat(file)
    if (!stat.isFile()) return null
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    let cached = manifests.get(directory)
    if (cached?.stamp !== stamp) {
      const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest
      if (manifest.version !== 1 || !manifest.assets || manifest.build !== digest(JSON.stringify(manifest.assets))) return null
      if (manifests.size >= 8) manifests.delete(manifests.keys().next().value!)
      cached = { stamp, manifest, verified: new Map() }
      manifests.set(directory, cached)
    }
    const name = relativePath + (encoding === "br" ? ".br" : encoding === "gzip" ? ".gz" : "")
    const expected = cached!.manifest.assets[name]
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected.sha256)) return null
    const assetPath = path.join(directory, name), metadata = await lstat(assetPath)
    if (!metadata.isFile() || metadata.size !== expected.bytes) return null
    const verificationStamp = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
    if (cached!.verified.get(name) !== verificationStamp) {
      if (digest(await readFile(assetPath)) !== expected.sha256) return null
      cached!.verified.set(name, verificationStamp)
    }
    return cached!.manifest.build + ":" + expected.sha256
  } catch { return null } // Old hosts and missing/invalid manifests retain no-store.
}
