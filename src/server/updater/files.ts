import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, stat, symlink } from "node:fs/promises"
import path from "node:path"

export async function exists(file: string) {
  try { await lstat(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function json<T>(file: string): Promise<T> {
  return JSON.parse((await Bun.file(file).text()).replace(/^\uFEFF/, "")) as T
}

export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally { await handle.close() }
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, file); break } catch (error) {
      if (process.platform !== "win32" || attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      await Bun.sleep(50)
    }
  }
  // Flush the rename on filesystems supporting directory fsync. Windows does not.
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), "r")
    try { await directory.sync() } finally { await directory.close() }
  }
}

export function inside(root: string, relative: string) {
  const result = path.resolve(root, relative)
  const relation = path.relative(path.resolve(root), result)
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("A path escaped the managed update directory.")
  }
  return result
}

export async function assertPlainDirectory(directory: string) {
  const details = await lstat(directory)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Linked runtime/data directories require manual migration.")
  }
}

const generated = new Set([".git", "node_modules", "dist", ".idea", ".vscode"])
// File digests remain compatible with existing build/data manifests. Source links
// record their text, never the contents reached by following them.
export type Manifest = Record<string, string>
const LINK_PREFIX = "symlink:"
const privateRoots = new Set([".stillon", ".stillon-dev", ".kanna", ".kanna-dev"])

async function sourceLink(root: string, file: string) {
  const target = await readlink(file)
  if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error("Absolute source links require manual migration.")
  }
  const canonicalRoot = await realpath(root)
  // realpath rejects dangling links/cycles and resolves indirect escapes.
  const resolved = await realpath(file)
  const relative = path.relative(canonicalRoot, resolved)
  inside(canonicalRoot, relative)
  const lexical = path.relative(path.resolve(root), path.resolve(path.dirname(file), target))
  inside(root, lexical)
  for (const candidate of [relative, lexical]) {
    if (candidate.split(path.sep).some((part, index) =>
      (generated.has(part) && (index === 0 || part === "node_modules")) || privateRoots.has(part))) {
      throw new Error("Source links into generated files or user data require manual migration.")
    }
  }
  return target
}

/** Copy one additional source entry without dereferencing links or linked parents. */
export async function copySourceEntry(source: string, target: string, relative: string) {
  const from = inside(source, relative)
  const to = inside(target, relative)
  await assertPlainDirectory(target)
  let parent = target
  for (const part of path.relative(path.resolve(target), path.dirname(to)).split(path.sep)) {
    if (part === ".") continue
    parent = path.join(parent, part)
    if (!await exists(parent)) await mkdir(parent)
    await assertPlainDirectory(parent)
  }
  if (await exists(to)) throw new Error("Refusing to overwrite an existing source entry.")
  const info = await lstat(from)
  if (info.isSymbolicLink()) {
    const link = await sourceLink(source, from)
    // Keep relative link text; validate the assembled runtime after all copies.
    await symlink(link, to, (await stat(from)).isDirectory() ? "dir" : "file")
  } else if (info.isFile()) {
    await copyFile(from, to, constants.COPYFILE_EXCL)
    await chmod(to, info.mode & 0o777)
  } else throw new Error("Special source files require manual migration.")
}

export async function manifest(root: string, sourceOnly = false): Promise<Manifest> {
  await assertPlainDirectory(root)
  const result: Manifest = {}
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (sourceOnly && ((generated.has(entry.name) && (directory === root || entry.name === "node_modules")) || /(?:\.log|\.tsbuildinfo|\.swp|\.swo)$/.test(entry.name) || [".DS_Store", "Thumbs.db"].includes(entry.name))) continue
      const file = path.join(directory, entry.name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) {
        if (!sourceOnly) throw new Error("A data or build file is a link; manual migration is required.")
        result[path.relative(root, file).split(path.sep).join("/")] = LINK_PREFIX + await sourceLink(root, file)
      } else if (info.isDirectory()) {
        await assertPlainDirectory(file)
        if (!sourceOnly) result[`${path.relative(root, file).split(path.sep).join("/")}/`] = "directory"
        await walk(file)
      } else if (info.isFile()) {
        const hash = createHash("sha256")
        for await (const chunk of Bun.file(file).stream()) hash.update(chunk)
        result[path.relative(root, file).split(path.sep).join("/")] = hash.digest("hex")
      } else throw new Error("Special files require manual migration.")
    }
  }
  await walk(root)
  return result
}

export function sameManifest(a: Manifest, b: Manifest) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export async function copyTree(source: string, target: string) {
  if (await exists(target)) throw new Error("Refusing to overwrite an existing backup or runtime.")
  const before = await manifest(source)
  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const relative of Object.keys(before)) {
    const destination = inside(target, relative)
    if (before[relative] === "directory") { await mkdir(destination, { recursive: true, mode: 0o700 }); continue }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(inside(source, relative), destination, constants.COPYFILE_EXCL)
    await chmod(destination, (await stat(inside(source, relative))).mode & 0o777)
  }
  if (!sameManifest(before, await manifest(source)) || !sameManifest(before, await manifest(target))) {
    throw new Error("Data changed during backup or backup verification failed.")
  }
  return before
}
