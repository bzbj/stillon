import { randomUUID } from "node:crypto"
import { chmod, cp, mkdir, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { bundleFiles } from "../distribution/bundle"

export const AGENT_BUNDLE_ID = "com.bzbj.stillon.agent"
export const AGENT_RELATIVE_EXECUTABLE = "StillOn Agent.app/Contents/MacOS/StillOn Agent"
export const agentDirectory = (home: string) => path.join(home, "Library/Application Support/StillOn/Agent")
export const agentExecutable = (home: string) => path.join(agentDirectory(home), AGENT_RELATIVE_EXECUTABLE)
export const runtimeAgentBundle = (runtime: string) => path.join(runtime, "macos/StillOn Agent.app")

export async function installAgentHelper(runtime: string, home: string): Promise<string> {
  const source = runtimeAgentBundle(runtime)
  const expected = await bundleFiles(source)
  if (!expected["Contents/MacOS/StillOn Agent"]?.executable || !expected["Contents/Info.plist"]) {
    throw new Error("Runtime is missing the macOS permission owner")
  }
  const directory = agentDirectory(home)
  const installed = path.join(directory, "StillOn Agent.app")
  const same = (actual: Awaited<ReturnType<typeof bundleFiles>>) => JSON.stringify(actual) === JSON.stringify(expected)
  async function pruneReplaced(keep?: string) {
    for (const entry of await readdir(directory)) {
      if (/^StillOn Agent\.app\.replaced-[0-9a-f-]{36}$/.test(entry)) {
        const candidate = path.join(directory, entry)
        if (candidate !== keep) await rm(candidate, { recursive: true, force: true })
      }
    }
  }
  try { if (same(await bundleFiles(installed))) {
    await pruneReplaced()
    return agentExecutable(home)
  } } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const staging = path.join(directory, `.staging-${randomUUID()}`)
  const staged = path.join(staging, "StillOn Agent.app")
  const replaced = `${installed}.replaced-${randomUUID()}`
  let moved = false
  try {
    await mkdir(staging, { mode: 0o700 })
    await cp(source, staged, { recursive: true })
    if (!same(await bundleFiles(staged))) throw new Error("macOS permission owner changed during installation")
    try { await rename(installed, replaced); moved = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try { await rename(staged, installed) } catch (error) {
      if (moved) await rename(replaced, installed)
      throw error
    }
  } finally { await rm(staging, { recursive: true, force: true }) }
  await pruneReplaced(moved ? replaced : undefined)
  return agentExecutable(home)
}
