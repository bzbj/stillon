import { rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import {
  getDataRootDir,
  getLegacyDataRootName,
} from "../shared/branding"

type RuntimeEnv = Record<string, string | undefined>

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

export interface BrandDataMigrationResult {
  status: "current" | "migrated" | "none"
  from: string | null
  to: string
}

export async function migrateLegacyBrandDataRoot(
  homeDir = homedir(),
  env: RuntimeEnv = process.env,
): Promise<BrandDataMigrationResult> {
  const canonicalRoot = getDataRootDir(homeDir, env)
  if (await pathExists(canonicalRoot)) {
    return { status: "current", from: null, to: canonicalRoot }
  }

  const legacyRoot = path.join(homeDir, getLegacyDataRootName(env))
  if (!(await pathExists(legacyRoot))) {
    return { status: "none", from: null, to: canonicalRoot }
  }

  try {
    await rename(legacyRoot, canonicalRoot)
  } catch (error) {
    throw new Error(
      `Unable to migrate the legacy data directory from ${legacyRoot} to ${canonicalRoot}. `
      + "Move it manually or make the parent directory writable, then start StillOn again.",
      { cause: error },
    )
  }

  return { status: "migrated", from: legacyRoot, to: canonicalRoot }
}
