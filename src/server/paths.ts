import { mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const PROJECT_DATA_DIR_NAME = ".stillon"
export const LEGACY_PROJECT_DATA_DIR_NAME = ".kanna"

export function resolveLocalPath(localPath: string) {
  const trimmed = localPath.trim()
  if (!trimmed) {
    throw new Error("Project path is required")
  }
  if (trimmed === "~") {
    return homedir()
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
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
