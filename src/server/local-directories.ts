import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import type { LocalDirectoryEntry, LocalDirectoryListResult } from "../shared/protocol"
import { resolveLocalPath } from "./paths"

async function isDirectoryEntry(parentPath: string, entryName: string, entryIsDirectory: boolean, entryIsSymlink: boolean) {
  if (entryIsDirectory) {
    return true
  }
  if (!entryIsSymlink) {
    return false
  }

  try {
    const info = await stat(path.join(parentPath, entryName))
    return info.isDirectory()
  } catch {
    return false
  }
}

function sortDirectoryEntries(left: LocalDirectoryEntry, right: LocalDirectoryEntry) {
  const leftHidden = left.name.startsWith(".")
  const rightHidden = right.name.startsWith(".")
  if (leftHidden !== rightHidden) {
    return leftHidden ? 1 : -1
  }
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
}

export async function listLocalDirectories(localPath?: string): Promise<LocalDirectoryListResult> {
  const resolvedPath = resolveLocalPath(localPath?.trim() || "~")
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Path must be a directory")
  }

  const rawEntries = await readdir(resolvedPath, { withFileTypes: true })
  const entries: LocalDirectoryEntry[] = []
  for (const entry of rawEntries) {
    if (!await isDirectoryEntry(resolvedPath, entry.name, entry.isDirectory(), entry.isSymbolicLink())) {
      continue
    }
    entries.push({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
    })
  }

  entries.sort(sortDirectoryEntries)
  const parentPath = path.dirname(resolvedPath)

  return {
    path: resolvedPath,
    parentPath: parentPath === resolvedPath ? null : parentPath,
    entries,
  }
}
