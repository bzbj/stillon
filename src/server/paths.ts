import { mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { ResolvedLocalPath } from "../shared/protocol"

export const PROJECT_DATA_DIR_NAME = ".stillon"
export const LEGACY_PROJECT_DATA_DIR_NAME = ".kanna"

interface PathOperations {
  join(...paths: string[]): string
  resolve(...paths: string[]): string
}

export function resolveLocalPathForPlatform(
  localPath: string,
  homeDirectory: string,
  pathOperations: PathOperations,
) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homeDirectory
  }
  if (/^~[\\/]/u.test(trimmed)) {
    return pathOperations.join(homeDirectory, trimmed.slice(2))
  }
  return pathOperations.resolve(trimmed)
}

export function resolveLocalPath(localPath: string) {
  return resolveLocalPathForPlatform(localPath, homedir(), path)
}

export function getResolvedLocalPath(localPath: string): ResolvedLocalPath {
  return {
    path: resolveLocalPath(localPath),
    separator: path.sep === "\\" ? "\\" : "/",
  }
}

export async function ensureProjectDirectory(localPath: string) {
  const resolvedPath = resolveLocalPath(localPath)

  await mkdir(resolvedPath, { recursive: true })
  const info = await stat(resolvedPath)
  if (!info.isDirectory()) {
    throw new Error("Project path must be a directory")
  }
}

export function getProjectUploadDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), PROJECT_DATA_DIR_NAME, "uploads")
}

export function getLegacyProjectUploadDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), LEGACY_PROJECT_DATA_DIR_NAME, "uploads")
}

export async function resolveProjectUploadFilePath(localPath: string, storedName: string) {
  const candidates = [
    path.join(getProjectUploadDir(localPath), storedName),
    path.join(getLegacyProjectUploadDir(localPath), storedName),
  ]

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Try the legacy project directory before reporting a missing upload.
    }
  }

  return null
}

export function getProjectExportDir(localPath: string) {
  return path.join(resolveLocalPath(localPath), PROJECT_DATA_DIR_NAME, "exports")
}
