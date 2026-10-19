import { readFile, stat } from "node:fs/promises"
import path from "node:path"

interface BuildEntry { file: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[] }

/** A small leaf ESM can be imported repeatedly without bootstrapping the app. */
export async function findBuildModuleProbe(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, ".vite/manifest.json"), "utf8")) as Record<string, BuildEntry>
  const candidates = [...new Set(Object.values(manifest).filter(entry =>
    !entry.isEntry && !entry.isDynamicEntry && !entry.imports?.length && !entry.dynamicImports?.length
    && /^assets\/[\w.-]+-[a-f0-9]{12}\.js$/u.test(entry.file)).map(entry => entry.file))]
  const files = await Promise.all(candidates.map(async file => ({ file, bytes: (await stat(path.join(directory, file))).size })))
  files.sort((left, right) => left.bytes - right.bytes || left.file.localeCompare(right.file))
  if (!files[0]) throw new Error("A generated leaf ESM is required for transport integrity checks")
  return "/" + files[0].file
}
