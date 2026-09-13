import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { updateCommand } from "./engine"

test.skipIf(process.platform !== "win32")("source preparation supports Windows paths beyond MAX_PATH without changing Git config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stillon-long-git-"))
  const source = path.join(root, "source")
  const destination = path.join(root, "transactions", "nested-rehearsal-".repeat(5), "runtime")
  const name = `${"personal-asset-".repeat(10)}.txt`
  try {
    await mkdir(source, { recursive: true })
    await updateCommand(["git", "init"], source)
    await writeFile(path.join(source, name), "personalization")
    await updateCommand(["git", "add", "."], source)
    await updateCommand(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], source)
    expect(path.join(destination, name).length).toBeGreaterThan(260)
    await mkdir(path.dirname(destination), { recursive: true })
    await updateCommand(["git", "clone", "--no-hardlinks", "--no-checkout", source, destination], root)
    await updateCommand(["git", "checkout", "--detach", "HEAD"], destination)
    expect(await Bun.file(path.join(destination, name)).text()).toBe("personalization")
    const config = await Bun.file(path.join(destination, ".git", "config")).text()
    expect(config).not.toMatch(/longpaths\s*=/i)
  } finally {
    const relative = path.relative(os.tmpdir(), root)
    if (!relative.startsWith("stillon-long-git-") || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error("Unexpected fixture cleanup path")
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
