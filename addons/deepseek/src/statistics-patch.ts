import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
declare const STILLON_DSH_STATISTICS_SOURCE: string

export async function statisticsPatch() {
  const directory = await mkdtemp(path.join(tmpdir(), "stillon-dsh-statistics-"))
  try {
  const plugin = path.join(directory, "statistics.mjs"), patch = path.join(directory, "statistics.json")
  let source: string
  if (typeof STILLON_DSH_STATISTICS_SOURCE !== "undefined") source = STILLON_DSH_STATISTICS_SOURCE
  else {
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "statistics-plugin.ts")], target: "node", format: "esm" })
    if (!build.success) throw new Error("Unable to prepare native Harness statistics bridge.")
    source = await build.outputs[0]!.text()
  }
  await writeFile(plugin, source, { mode: 0o600 })
  await writeFile(patch, JSON.stringify([{ insert: [
    { id: "stillon-native-session-stats", name: "@deepseek-ai/dsh-session-stats" },
    { id: "stillon-session-statistics", name: plugin },
  ] }]), { mode: 0o600 })
  return { directory, patch }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}
