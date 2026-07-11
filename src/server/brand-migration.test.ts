import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { migrateLegacyBrandDataRoot } from "./brand-migration"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("brand data migration", () => {
  test("moves the legacy Kanna data root to StillOn on first launch", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "stillon-brand-migration-"))
    tempDirs.push(homeDir)
    const legacyDataDir = path.join(homeDir, ".kanna", "data")
    await mkdir(legacyDataDir, { recursive: true })
    await writeFile(path.join(legacyDataDir, "settings.json"), "{}")

    const result = await migrateLegacyBrandDataRoot(homeDir, { STILLON_RUNTIME_PROFILE: "prod" })

    expect(result).toEqual({
      status: "migrated",
      from: path.join(homeDir, ".kanna"),
      to: path.join(homeDir, ".stillon"),
    })
    await expect(stat(path.join(homeDir, ".stillon", "data", "settings.json"))).resolves.toBeTruthy()
    await expect(stat(path.join(homeDir, ".kanna"))).rejects.toThrow()
  })

  test("leaves an existing StillOn data root untouched", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "stillon-brand-current-"))
    tempDirs.push(homeDir)
    await mkdir(path.join(homeDir, ".stillon"), { recursive: true })
    await mkdir(path.join(homeDir, ".kanna"), { recursive: true })

    const result = await migrateLegacyBrandDataRoot(homeDir, {})

    expect(result.status).toBe("current")
    await expect(stat(path.join(homeDir, ".kanna"))).resolves.toBeTruthy()
  })
})
