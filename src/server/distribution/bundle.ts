import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { exists, inside, json } from "../updater/files"
import { releaseTag, updateTarget, type UpdateArchitecture, type UpdatePlatform } from "../updater/model"

export const BUNDLE_FILE = "stillon-bundle.json"
export const RELEASE_FILE = "stillon-release.json"
export const PACKAGE_PROTOCOL = 1
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
export const MAX_RUNTIME_BYTES = 1536 * 1024 * 1024

export interface BundleFile { sha256: string; size: number; executable: boolean }
export interface RuntimeBundle {
  schema: 1
  version: string
  buildId: string
  revision: string
  platform: UpdatePlatform
  architecture: UpdateArchitecture
  bunVersion: string
  minimumUpdaterProtocol: number
  files: Record<string, BundleFile>
}
export interface ReleaseArtifact {
  platform: UpdatePlatform
  architecture: UpdateArchitecture
  name: string
  sha256: string
  size: number
  buildId: string
}
export interface DesktopRelease { schema: 1; tag: string; artifacts: ReleaseArtifact[] }

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
export const bunRelativePath = (platform: string) => `runtime/${platform === "win32" ? "bun.exe" : "bun"}`
export const artifactName = (version: string, platform: string, architecture: string) =>
  `stillon-${releaseTag(version)}-${platform}-${architecture}.tar.gz`

/** Apply the same conservative names on all four targets, including NTFS ADS. */
export function validateBundlePath(name: string) {
  if (!name || name.length > 220 || /[\\\x00-\x1f:<>"|?*]/.test(name) || name.startsWith("/")) throw new Error("Invalid bundle path")
  if (name.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid bundle path")
  return name
}

export function validateBundle(value: unknown, expected?: { platform: UpdatePlatform; architecture: UpdateArchitecture; tag?: string }) {
  const bundle = value as RuntimeBundle
  if (!bundle || bundle.schema !== 1 || !/^[a-zA-Z0-9.-]{1,100}$/.test(bundle.buildId)
    || !/^[a-f0-9]{40}$/.test(bundle.revision) || typeof bundle.bunVersion !== "string"
    || !Number.isSafeInteger(bundle.minimumUpdaterProtocol) || bundle.minimumUpdaterProtocol < 1
    || bundle.minimumUpdaterProtocol > PACKAGE_PROTOCOL || !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) {
    throw new Error("Unsupported runtime bundle or updater protocol")
  }
  releaseTag(bundle.version)
  updateTarget(bundle.platform, bundle.architecture)
  if (expected && (bundle.platform !== expected.platform || bundle.architecture !== expected.architecture
    || (expected.tag && releaseTag(bundle.version) !== releaseTag(expected.tag)))) throw new Error("Runtime bundle platform, architecture or version mismatch")
  const names = Object.keys(bundle.files)
  if (!names.length || names.length > 30_000) throw new Error("Invalid runtime file count")
  const canonical = new Set<string>()
  let total = 0
  for (const name of names) {
    validateBundlePath(name)
    if (name === BUNDLE_FILE || canonical.has(name.toLowerCase())) throw new Error("Duplicate runtime file")
    canonical.add(name.toLowerCase())
    const file = bundle.files[name]
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.executable !== "boolean") {
      throw new Error("Invalid runtime file metadata")
    }
    total += file.size
  }
  if (total > MAX_RUNTIME_BYTES) throw new Error("Runtime bundle is too large")
  for (const name of ["package.json", "bin/stillon", "src/server/cli.ts", "dist/client/index.html", "dist/export-viewer/index.html", "runtime/controller.js", bunRelativePath(bundle.platform)]) {
    if (!Object.hasOwn(bundle.files, name)) throw new Error(`Runtime bundle is missing ${name}`)
  }
  return bundle
}

export async function bundleFiles(root: string): Promise<Record<string, BundleFile>> {
  const result: Record<string, BundleFile> = Object.create(null)
  async function walk(directory: string) {
    const details = await lstat(directory)
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("Linked runtime directory")
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry)
      const name = path.relative(root, file).split(path.sep).join("/")
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error(`Runtime links are not supported: ${name}`)
      if (stat.isDirectory()) { await walk(file); continue }
      if (!stat.isFile()) throw new Error("Special runtime file")
      if (name === BUNDLE_FILE) continue
      validateBundlePath(name)
      const hash = createHash("sha256")
      for await (const chunk of Bun.file(file).stream()) hash.update(chunk)
      result[name] = { sha256: hash.digest("hex"), size: stat.size, executable: !!(stat.mode & 0o111) }
    }
  }
  await walk(root)
  return result
}

export async function verifyBundle(root: string, expected?: Parameters<typeof validateBundle>[1]) {
  const bundle = validateBundle(await json(path.join(root, BUNDLE_FILE)), expected)
  const actual = await bundleFiles(root)
  if (Object.keys(actual).length !== Object.keys(bundle.files).length
    || Object.entries(bundle.files).some(([name, file]) => actual[name]?.sha256 !== file.sha256
      || actual[name]?.size !== file.size || (process.platform !== "win32" && actual[name]?.executable !== file.executable))) {
    throw new Error("Installed runtime files changed. Keep themes and skins in the user data directory; use a source checkout for code edits.")
  }
  if (releaseTag((await json<{ version: string }>(path.join(root, "package.json"))).version) !== releaseTag(bundle.version)) throw new Error("Bundle version mismatch")
  return bundle
}

export async function runtimeExecutable(runtime: string, fallback: string) {
  if (!await exists(path.join(runtime, BUNDLE_FILE))) return fallback
  const bundle = validateBundle(await json(path.join(runtime, BUNDLE_FILE)))
  return inside(runtime, bunRelativePath(bundle.platform))
}

/** Write regular files ourselves. Archive symlinks/hardlinks never reach disk. */
export async function unpackBundle(bytes: Uint8Array, destination: string, expected: Parameters<typeof validateBundle>[1]) {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Runtime download is too large")
  const plain = gunzipSync(bytes, { maxOutputLength: MAX_RUNTIME_BYTES })
  const files = await new Bun.Archive(plain).files()
  const metadata = files.get(BUNDLE_FILE)
  if (!metadata || metadata.size > 8 * 1024 * 1024) throw new Error("Runtime bundle manifest is missing or too large")
  const bundle = validateBundle(JSON.parse(await metadata.text()), expected)
  if (files.size !== Object.keys(bundle.files).length + 1) throw new Error("Unexpected runtime archive contents")
  for (const [name, file] of files) {
    validateBundlePath(name)
    if (name === BUNDLE_FILE) continue
    if (!Object.hasOwn(bundle.files, name) || file.size !== bundle.files[name].size
      || sha256(await file.bytes()) !== bundle.files[name].sha256) throw new Error("Runtime archive file checksum mismatch")
  }
  if (await exists(destination)) throw new Error("Refusing to overwrite an installed runtime")
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const [name, file] of files) {
    const target = inside(destination, name)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, new Uint8Array(await file.arrayBuffer()), { flag: "wx", mode: bundle.files[name]?.executable ? 0o755 : 0o644 })
    if (process.platform !== "win32") await chmod(target, bundle.files[name]?.executable ? 0o755 : 0o644)
  }
  await verifyBundle(destination, expected)
  return bundle
}

export function selectArtifact(value: unknown, tag: string, target: { platform: UpdatePlatform; architecture: UpdateArchitecture }) {
  const release = value as DesktopRelease
  if (!release || release.schema !== 1 || releaseTag(release.tag) !== releaseTag(tag) || !Array.isArray(release.artifacts)) throw new Error("Invalid desktop release metadata")
  const matches = release.artifacts.filter((item) => item.platform === target.platform && item.architecture === target.architecture)
  if (matches.length !== 1) throw new Error("This release has no unique package for this operating system and architecture")
  const artifact = matches[0]
  if (artifact.name !== artifactName(tag, target.platform, target.architecture) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !/^[a-zA-Z0-9.-]{1,100}$/.test(artifact.buildId) || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARCHIVE_BYTES) throw new Error("Invalid desktop release artifact")
  return artifact
}
